import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { calendarDeps } from '../src/calendar/client.js';
import { CALENDAR_EVENTS_SCOPE, SCOPES, formatScopeInfo } from '../src/gmail/auth.js';
import { registerAllTools } from '../src/tools/index.js';

const CALENDAR_TOOLS = [
  'calendar_list_calendars',
  'calendar_list_events',
  'calendar_get_event',
  'calendar_freebusy',
  'calendar_create_event',
  'calendar_update_event',
];

const WORK_ACCOUNT = { email: 'work@example.com', alias: 'work' };

function resultText(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.map(item => (item && typeof item === 'object' && 'text' in item ? String(item.text) : '')).join('\n');
}

function insufficientScopeError(): Error {
  return Object.assign(new Error('Request had insufficient authentication scopes.'), {
    code: 403,
    errors: [{ reason: 'insufficientPermissions', message: 'Insufficient Permission' }],
    response: {
      status: 403,
      data: {
        error: {
          code: 403,
          message: 'Request had insufficient authentication scopes.',
          status: 'PERMISSION_DENIED',
          details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
        },
      },
    },
  });
}

function installCalendarMock(api: Record<string, unknown>) {
  const resolveAccount = mock.method(calendarDeps, 'resolveAccount', () => WORK_ACCOUNT);
  const getAuthClient = mock.method(calendarDeps, 'getAuthClient', async () => ({}));
  const createCalendar = mock.method(calendarDeps, 'createCalendar', () => api);
  return {
    resolveAccount,
    getAuthClient,
    createCalendar,
    restore() {
      resolveAccount.mock.restore();
      getAuthClient.mock.restore();
      createCalendar.mock.restore();
    },
  };
}

describe('calendar tools', { concurrency: false }, () => {
  let client: Client;
  let server: McpServer;

  before(async () => {
    server = new McpServer(
      { name: 'gmail-mcp-test', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    registerAllTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'calendar-test', version: '1.0.0' });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  after(async () => {
    await client.close();
    await server.close();
  });

  it('registers the six calendar tools and no delete tool', async () => {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    const calendarNames = names.filter(name => name.startsWith('calendar_')).sort();
    assert.deepEqual(calendarNames, [...CALENDAR_TOOLS].sort());
    assert.equal(names.some(name => /delete/i.test(name)), false);
    assert.ok(names.includes('list_emails'));
  });

  it('reports whether calendar.events is granted without dropping Gmail status', () => {
    assert.ok(SCOPES.includes(CALENDAR_EVENTS_SCOPE));
    assert.ok(SCOPES.includes('https://www.googleapis.com/auth/gmail.send'));

    const gmailOnly = SCOPES.filter(scope => scope !== CALENDAR_EVENTS_SCOPE).join(' ');
    const gmailOnlyInfo = formatScopeInfo(gmailOnly);
    assert.match(gmailOnlyInfo, /\[send\+compose\]/);
    assert.match(gmailOnlyInfo, /\[calendar: not granted\]/);
    assert.doesNotMatch(gmailOnlyInfo, /\[calendar: granted\]/);

    assert.match(formatScopeInfo(SCOPES.join(' ')), /\[calendar: granted\]/);
    assert.equal(
      formatScopeInfo(`https://www.googleapis.com/auth/calendar.events.readonly ${gmailOnly}`).includes('[calendar: granted]'),
      false,
    );
  });

  it('returns a re-run npm run auth message when the calendar scope is missing', async () => {
    const list = mock.fn(async () => {
      throw insufficientScopeError();
    });
    const installed = installCalendarMock({ events: { list } });
    try {
      const result = await client.callTool({
        name: 'calendar_list_events',
        arguments: { calendar_id: 'primary' },
      });
      assert.equal(result.isError, true);
      const text = resultText(result);
      assert.match(text, /npm run auth/);
      assert.match(text, /work@example.com/);
      assert.match(text, /npm run auth -- work/);
      assert.equal(list.mock.callCount(), 1);
    } finally {
      installed.restore();
    }
  });

  it('does not rewrite a non-scope calendar error into a re-auth message', async () => {
    const list = mock.fn(async () => {
      throw Object.assign(new Error('Forbidden'), { code: 403 });
    });
    const installed = installCalendarMock({ events: { list } });
    try {
      const result = await client.callTool({
        name: 'calendar_list_events',
        arguments: {},
      });
      assert.equal(result.isError, true);
      const text = resultText(result);
      assert.match(text, /Forbidden/);
      assert.doesNotMatch(text, /npm run auth/);
    } finally {
      installed.restore();
    }
  });

  it('defaults sendUpdates to none on create and update when there are no attendees', async () => {
    const insert = mock.fn(async () => ({ data: { id: 'evt_new', summary: 'Standup' } }));
    const patch = mock.fn(async () => ({ data: { id: 'evt_1', summary: 'Renamed' } }));
    const installed = installCalendarMock({ events: { insert, patch } });
    try {
      const created = await client.callTool({
        name: 'calendar_create_event',
        arguments: {
          summary: 'Standup',
          start: '2026-10-30T15:00:00Z',
          end: '2026-10-30T15:30:00Z',
        },
      });
      assert.notEqual(created.isError, true);
      const insertParams = insert.mock.calls[0].arguments[0] as {
        sendUpdates?: string;
        calendarId?: string;
        requestBody?: { attendees?: unknown; summary?: string };
      };
      assert.equal(insertParams.sendUpdates, 'none');
      assert.equal(insertParams.calendarId, 'primary');
      assert.equal(insertParams.requestBody?.summary, 'Standup');
      assert.equal(insertParams.requestBody?.attendees, undefined);

      const updated = await client.callTool({
        name: 'calendar_update_event',
        arguments: { event_id: 'evt_1', summary: 'Renamed' },
      });
      assert.notEqual(updated.isError, true);
      const patchParams = patch.mock.calls[0].arguments[0] as {
        sendUpdates?: string;
        calendarId?: string;
        eventId?: string;
        requestBody?: { summary?: string; attendees?: unknown };
      };
      assert.equal(patchParams.sendUpdates, 'none');
      assert.equal(patchParams.calendarId, 'primary');
      assert.equal(patchParams.eventId, 'evt_1');
      assert.deepEqual(patchParams.requestBody, { summary: 'Renamed' });
    } finally {
      installed.restore();
    }
  });

  it('requires an explicit sendUpdates when attendees are set and does not email them by default', async () => {
    const insert = mock.fn(async () => ({ data: { id: 'evt_new' } }));
    const patch = mock.fn(async () => ({ data: { id: 'evt_1' } }));
    const installed = installCalendarMock({ events: { insert, patch } });
    try {
      const created = await client.callTool({
        name: 'calendar_create_event',
        arguments: {
          summary: 'Sync',
          start: '2026-10-30T15:00:00Z',
          end: '2026-10-30T15:30:00Z',
          attendees: ['guest@example.com'],
        },
      });
      assert.equal(created.isError, true);
      assert.match(resultText(created), /sendUpdates is required/);
      assert.equal(insert.mock.callCount(), 0);
      assert.equal(installed.getAuthClient.mock.callCount(), 0);

      const updated = await client.callTool({
        name: 'calendar_update_event',
        arguments: { event_id: 'evt_1', attendees: ['guest@example.com'] },
      });
      assert.equal(updated.isError, true);
      assert.match(resultText(updated), /sendUpdates is required/);
      assert.equal(patch.mock.callCount(), 0);

      const explicit = await client.callTool({
        name: 'calendar_create_event',
        arguments: {
          summary: 'Sync',
          start: '2026-10-30T15:00:00Z',
          end: '2026-10-30T15:30:00Z',
          attendees: ['guest@example.com'],
          send_updates: 'none',
        },
      });
      assert.notEqual(explicit.isError, true);
      const params = insert.mock.calls[0].arguments[0] as {
        sendUpdates?: string;
        requestBody?: { attendees?: Array<{ email?: string }> };
      };
      assert.equal(params.sendUpdates, 'none');
      assert.deepEqual(params.requestBody?.attendees, [{ email: 'guest@example.com' }]);
    } finally {
      installed.restore();
    }
  });
});
