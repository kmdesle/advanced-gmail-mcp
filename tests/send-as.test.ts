import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gmailDeps } from '../src/gmail/client.js';
import { registerAllTools } from '../src/tools/index.js';

const PRIMARY_EMAIL = 'kevin@cyberwingman.ai';
const ACCOUNT = { email: PRIMARY_EMAIL, alias: 'wingman' };

const SEND_AS_ALIASES = [
  {
    sendAsEmail: PRIMARY_EMAIL,
    displayName: 'Kevin Desler',
    isDefault: true,
    isPrimary: true,
    verificationStatus: 'accepted',
  },
  {
    sendAsEmail: 'support@cyberwingman.ai',
    displayName: 'Cyberwingman Support',
    isDefault: false,
    verificationStatus: 'accepted',
  },
  {
    sendAsEmail: 'nodisplay@cyberwingman.ai',
    displayName: '',
    isDefault: false,
    verificationStatus: 'accepted',
  },
  {
    sendAsEmail: 'pending@cyberwingman.ai',
    displayName: 'Pending Support',
    isDefault: false,
    verificationStatus: 'pending',
  },
];

function resultText(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((item) => (item && typeof item === 'object' && 'text' in item ? String(item.text) : ''))
    .join('\n');
}

function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

function parseHeaders(rawEmail: string): Map<string, string> {
  const [headerSection] = rawEmail.split('\r\n\r\n');
  const headers = new Map<string, string>();
  for (const line of headerSection.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers.set(key, value);
    }
  }
  return headers;
}

describe('send-as aliases and optional from parameter', { concurrency: false }, () => {
  let client: Client;
  let server: McpServer;
  let resolveAccountMock: ReturnType<typeof mock.method>;
  let getGmailClientMock: ReturnType<typeof mock.method>;

  let lastSentRequestBody: { raw?: string; threadId?: string } | undefined;
  let lastDraftRequestBody: { message?: { raw?: string; threadId?: string } } | undefined;

  before(async () => {
    const mockGmail = {
      users: {
        settings: {
          sendAs: {
            list: mock.fn(async () => ({
              data: { sendAs: SEND_AS_ALIASES },
            })),
          },
        },
        messages: {
          send: mock.fn(async (params: { requestBody: { raw?: string; threadId?: string } }) => {
            lastSentRequestBody = params.requestBody;
            return {
              data: {
                id: 'sent-msg-id-1',
                threadId: params.requestBody.threadId || 'thread-new-1',
                labelIds: ['SENT'],
              },
            };
          }),
          get: mock.fn(async () => ({
            data: {
              id: 'original-msg-1',
              threadId: 'original-thread-1',
              payload: {
                headers: [
                  { name: 'From', value: 'Alice <alice@example.com>' },
                  { name: 'To', value: 'kevin@cyberwingman.ai' },
                  { name: 'Cc', value: 'bob@example.com' },
                  { name: 'Subject', value: 'Project Status' },
                  { name: 'Message-ID', value: '<msg-100@example.com>' },
                  { name: 'References', value: '<root-msg@example.com>' },
                ],
              },
            },
          })),
        },
        drafts: {
          create: mock.fn(async (params: { requestBody: { message?: { raw?: string; threadId?: string } } }) => {
            lastDraftRequestBody = params.requestBody;
            return {
              data: {
                id: 'draft-id-1',
                message: {
                  id: 'draft-msg-id-1',
                  threadId: params.requestBody.message?.threadId || 'thread-draft-1',
                },
              },
            };
          }),
        },
      },
    };

    resolveAccountMock = mock.method(gmailDeps, 'resolveAccount', () => ACCOUNT);
    getGmailClientMock = mock.method(gmailDeps, 'getGmailClient', async () => mockGmail as never);

    server = new McpServer({ name: 'gmail-send-as-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    registerAllTools(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  after(async () => {
    await client.close();
    await server.close();
    resolveAccountMock.mock.restore();
    getGmailClientMock.mock.restore();
  });

  it('list_send_as returns sendAsEmail, displayName, isDefault, verificationStatus', async () => {
    const res = await client.callTool({
      name: 'list_send_as',
      arguments: { account: 'wingman' },
    });
    assert.notEqual(res.isError, true, resultText(res));
    const list = JSON.parse(resultText(res));
    assert.equal(list.length, 4);
    assert.deepEqual(list[0], {
      sendAsEmail: PRIMARY_EMAIL,
      displayName: 'Kevin Desler',
      isDefault: true,
      verificationStatus: 'accepted',
    });
    assert.deepEqual(list[1], {
      sendAsEmail: 'support@cyberwingman.ai',
      displayName: 'Cyberwingman Support',
      isDefault: false,
      verificationStatus: 'accepted',
    });
    assert.deepEqual(list[3], {
      sendAsEmail: 'pending@cyberwingman.ai',
      displayName: 'Pending Support',
      isDefault: false,
      verificationStatus: 'pending',
    });
  });

  describe('send_email', () => {
    it('accepts verified alias with no display name and uses alias configured displayName', async () => {
      const res = await client.callTool({
        name: 'send_email',
        arguments: {
          to: 'customer@example.com',
          subject: 'Help request',
          body: 'We are on it!',
          from: 'support@cyberwingman.ai',
        },
      });
      assert.notEqual(res.isError, true, resultText(res));
      assert.ok(lastSentRequestBody?.raw);
      const raw = decodeRaw(lastSentRequestBody.raw);
      const headers = parseHeaders(raw);
      assert.equal(headers.get('from'), 'Cyberwingman Support <support@cyberwingman.ai>');
      assert.equal(headers.get('to'), 'customer@example.com');
      assert.equal(headers.get('subject'), 'Help request');
    });

    it('accepts verified alias with caller-provided custom displayName', async () => {
      const res = await client.callTool({
        name: 'send_email',
        arguments: {
          to: 'customer@example.com',
          subject: 'Help request',
          body: 'Custom name here',
          from: 'Custom Agent <support@cyberwingman.ai>',
        },
      });
      assert.notEqual(res.isError, true, resultText(res));
      assert.ok(lastSentRequestBody?.raw);
      const headers = parseHeaders(decodeRaw(lastSentRequestBody.raw));
      assert.equal(headers.get('from'), 'Custom Agent <support@cyberwingman.ai>');
    });

    it('accepts verified alias when alias has no configured displayName', async () => {
      const res = await client.callTool({
        name: 'send_email',
        arguments: {
          to: 'customer@example.com',
          subject: 'Help request',
          body: 'No display name configured',
          from: 'nodisplay@cyberwingman.ai',
        },
      });
      assert.notEqual(res.isError, true, resultText(res));
      assert.ok(lastSentRequestBody?.raw);
      const headers = parseHeaders(decodeRaw(lastSentRequestBody.raw));
      assert.equal(headers.get('from'), 'nodisplay@cyberwingman.ai');
    });

    it('accepts primary address', async () => {
      const res = await client.callTool({
        name: 'send_email',
        arguments: {
          to: 'customer@example.com',
          subject: 'Personal note',
          body: 'From Kevin directly',
          from: PRIMARY_EMAIL,
        },
      });
      assert.notEqual(res.isError, true, resultText(res));
      assert.ok(lastSentRequestBody?.raw);
      const headers = parseHeaders(decodeRaw(lastSentRequestBody.raw));
      assert.equal(headers.get('from'), 'Kevin Desler <kevin@cyberwingman.ai>');
    });

    it('rejects unverified alias and names allowed aliases', async () => {
      const res = await client.callTool({
        name: 'send_email',
        arguments: {
          to: 'customer@example.com',
          subject: 'Test',
          body: 'Should fail',
          from: 'pending@cyberwingman.ai',
        },
      });
      assert.equal(res.isError, true);
      const text = resultText(res);
      assert.match(text, /Invalid "from" address: "pending@cyberwingman\.ai"/);
      assert.match(text, /Allowed aliases:/);
      assert.match(text, /kevin@cyberwingman\.ai/);
      assert.match(text, /support@cyberwingman\.ai/);
      assert.ok(!text.includes('pending@cyberwingman.ai. Allowed aliases:'));
    });

    it('rejects unknown address and names allowed aliases', async () => {
      const res = await client.callTool({
        name: 'send_email',
        arguments: {
          to: 'customer@example.com',
          subject: 'Test',
          body: 'Should fail',
          from: 'imposter@evil.com',
        },
      });
      assert.equal(res.isError, true);
      const text = resultText(res);
      assert.match(text, /Invalid "from" address: "imposter@evil\.com"/);
      assert.match(text, /Allowed aliases:/);
      assert.match(text, /kevin@cyberwingman\.ai/);
      assert.match(text, /support@cyberwingman\.ai/);
    });

    it('rejects a from value containing line breaks (header injection)', async () => {
      const res = await client.callTool({
        name: 'send_email',
        arguments: {
          to: 'customer@example.com',
          subject: 'Test',
          body: 'Should fail',
          from: 'Support\r\nBcc: attacker@evil.com <support@cyberwingman.ai>',
        },
      });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /line breaks are not allowed/);
    });

    it('calls without from behave exactly as before (default unchanged)', async () => {
      const res = await client.callTool({
        name: 'send_email',
        arguments: {
          to: 'customer@example.com',
          subject: 'Default from test',
          body: 'Default behavior unchanged',
        },
      });
      assert.notEqual(res.isError, true, resultText(res));
      assert.ok(lastSentRequestBody?.raw);
      const headers = parseHeaders(decodeRaw(lastSentRequestBody.raw));
      assert.equal(headers.get('from'), PRIMARY_EMAIL);
    });
  });

  describe('reply_email', () => {
    it('accepts verified alias, sets from header, and preserves threading headers and threadId', async () => {
      const res = await client.callTool({
        name: 'reply_email',
        arguments: {
          message_id: 'original-msg-1',
          body: 'Replying from support team',
          from: 'support@cyberwingman.ai',
        },
      });
      assert.notEqual(res.isError, true, resultText(res));
      assert.ok(lastSentRequestBody?.raw);
      assert.equal(lastSentRequestBody?.threadId, 'original-thread-1');

      const headers = parseHeaders(decodeRaw(lastSentRequestBody.raw));
      assert.equal(headers.get('from'), 'Cyberwingman Support <support@cyberwingman.ai>');
      assert.equal(headers.get('to'), 'Alice <alice@example.com>');
      assert.equal(headers.get('subject'), 'Re: Project Status');
      assert.equal(headers.get('in-reply-to'), '<msg-100@example.com>');
      assert.equal(headers.get('references'), '<root-msg@example.com> <msg-100@example.com>');
    });

    it('rejects unverified alias on reply_email', async () => {
      const res = await client.callTool({
        name: 'reply_email',
        arguments: {
          message_id: 'original-msg-1',
          body: 'Replying from unverified alias',
          from: 'pending@cyberwingman.ai',
        },
      });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /Allowed aliases:/);
    });

    it('calls without from on reply_email behave exactly as before', async () => {
      const res = await client.callTool({
        name: 'reply_email',
        arguments: {
          message_id: 'original-msg-1',
          body: 'Replying without from',
        },
      });
      assert.notEqual(res.isError, true, resultText(res));
      assert.ok(lastSentRequestBody?.raw);
      const headers = parseHeaders(decodeRaw(lastSentRequestBody.raw));
      assert.equal(headers.get('from'), PRIMARY_EMAIL);
      assert.equal(headers.get('in-reply-to'), '<msg-100@example.com>');
      assert.equal(lastSentRequestBody?.threadId, 'original-thread-1');
    });
  });

  describe('draft_email', () => {
    it('creates draft with verified alias', async () => {
      const res = await client.callTool({
        name: 'draft_email',
        arguments: {
          to: 'customer@example.com',
          subject: 'Draft subject',
          body: 'Draft body',
          from: 'support@cyberwingman.ai',
        },
      });
      assert.notEqual(res.isError, true, resultText(res));
      assert.ok(lastDraftRequestBody?.message?.raw);
      const headers = parseHeaders(decodeRaw(lastDraftRequestBody.message.raw));
      assert.equal(headers.get('from'), 'Cyberwingman Support <support@cyberwingman.ai>');
    });

    it('rejects unverified alias on draft_email', async () => {
      const res = await client.callTool({
        name: 'draft_email',
        arguments: {
          to: 'customer@example.com',
          subject: 'Draft subject',
          body: 'Draft body',
          from: 'pending@cyberwingman.ai',
        },
      });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /Allowed aliases:/);
    });

    it('calls without from on draft_email behave exactly as before', async () => {
      const res = await client.callTool({
        name: 'draft_email',
        arguments: {
          to: 'customer@example.com',
          subject: 'Draft subject',
          body: 'Draft body',
        },
      });
      assert.notEqual(res.isError, true, resultText(res));
      assert.ok(lastDraftRequestBody?.message?.raw);
      const headers = parseHeaders(decodeRaw(lastDraftRequestBody.message.raw));
      assert.equal(headers.get('from'), PRIMARY_EMAIL);
    });
  });

  describe('draft_reply', () => {
    it('creates draft reply with verified alias and preserves threading headers and threadId', async () => {
      const res = await client.callTool({
        name: 'draft_reply',
        arguments: {
          message_id: 'original-msg-1',
          body: 'Draft reply body',
          from: 'support@cyberwingman.ai',
        },
      });
      assert.notEqual(res.isError, true, resultText(res));
      assert.ok(lastDraftRequestBody?.message?.raw);
      assert.equal(lastDraftRequestBody?.message?.threadId, 'original-thread-1');

      const headers = parseHeaders(decodeRaw(lastDraftRequestBody.message.raw));
      assert.equal(headers.get('from'), 'Cyberwingman Support <support@cyberwingman.ai>');
      assert.equal(headers.get('to'), 'Alice <alice@example.com>');
      assert.equal(headers.get('subject'), 'Re: Project Status');
      assert.equal(headers.get('in-reply-to'), '<msg-100@example.com>');
      assert.equal(headers.get('references'), '<root-msg@example.com> <msg-100@example.com>');
    });

    it('rejects unverified alias on draft_reply', async () => {
      const res = await client.callTool({
        name: 'draft_reply',
        arguments: {
          message_id: 'original-msg-1',
          body: 'Draft reply body',
          from: 'pending@cyberwingman.ai',
        },
      });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /Allowed aliases:/);
    });

    it('calls without from on draft_reply behave exactly as before', async () => {
      const res = await client.callTool({
        name: 'draft_reply',
        arguments: {
          message_id: 'original-msg-1',
          body: 'Draft reply without from',
        },
      });
      assert.notEqual(res.isError, true, resultText(res));
      assert.ok(lastDraftRequestBody?.message?.raw);
      const headers = parseHeaders(decodeRaw(lastDraftRequestBody.message.raw));
      assert.equal(headers.get('from'), PRIMARY_EMAIL);
      assert.equal(headers.get('in-reply-to'), '<msg-100@example.com>');
      assert.equal(lastDraftRequestBody?.message?.threadId, 'original-thread-1');
    });
  });
});
