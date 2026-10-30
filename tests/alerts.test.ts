import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { AccountWatcher, matchesRule, parseRules, type ReadonlyGmail, type Alert } from '../src/alerts/watcher.js';

const rule = { account: 'tractic', from: ['alfred.gpt@ktagroupinc.com'], tag: 'ALFRED' };
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true });
});

async function setup(seed = true) {
  // Keep test scratch inside the isolated checkout; never use real account/token files.
  const dir = await mkdtemp(join(process.cwd(), '.alerts-test-'));
  directories.push(dir);
  if (seed) await writeFile(join(dir, 'tractic.json'), JSON.stringify({ historyId: '10' }));
  const calls: unknown[] = [];
  const logs: string[] = [];
  const gmail: ReadonlyGmail = { users: {
    history: { list: async params => {
      calls.push(params);
      return { data: { historyId: '20', history: [{ messagesAdded: [{ message: { id: 'm1' } }] }] } };
    } },
    messages: { get: async params => {
      calls.push(params);
      return { data: { id: 'm1', threadId: 't1', payload: { headers: [
        { name: 'From', value: 'Alfred <alfred.gpt@ktagroupinc.com>' },
        { name: 'Subject', value: 'Status update' }, { name: 'Date', value: 'Fri, 30 Oct 2026 00:00:00 GMT' },
      ] } } };
    } },
    getProfile: async params => { calls.push(params); return { data: { historyId: '30' } }; },
  } };
  const watcher = new AccountWatcher('tractic', [rule], dir, async () => gmail, line => logs.push(line), () => new Date('2026-10-30T00:00:00Z'));
  const alerts = async (): Promise<Alert[]> => (await readFile(join(dir, 'alerts.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { dir, calls, logs, gmail, watcher, alerts };
}

test('rules use exact case-insensitive sender mailbox, account, and optional any subject substring', () => {
  assert.ok(matchesRule(rule, 'tractic', 'Alfred <ALFRED.GPT@ktagroupinc.com>', 'Anything'));
  assert.ok(matchesRule(rule, 'tractic', rule.from[0], 'Anything'));
  assert.equal(matchesRule(rule, 'other', rule.from[0], ''), false);
  assert.equal(matchesRule(rule, 'tractic', `evil${rule.from[0]}`, ''), false);
  assert.equal(matchesRule(rule, 'tractic', `${rule.from[0]} <evil@example.com>`, ''), false);
  const filtered = { ...rule, subject_contains: ['invoice', 'STATUS'] };
  assert.ok(matchesRule(filtered, 'tractic', rule.from[0], 'New status update'));
  assert.equal(matchesRule(filtered, 'tractic', rule.from[0], 'Meeting'), false);
  assert.deepEqual(parseRules([rule]), [rule]);
  for (const invalid of [[], {}, [{ ...rule, account: '../escape' }], [{ ...rule, from: [] }], [{ ...rule, subject_contains: [] }]]) {
    assert.throws(() => parseRules(invalid));
  }
});

test('fetches metadata only and writes exactly the specified alert fields and durable cursor', async () => {
  const f = await setup();
  await f.watcher.poll();
  assert.deepEqual(f.calls, [
    { userId: 'me', startHistoryId: '10', historyTypes: ['messageAdded'], labelId: 'INBOX', pageToken: undefined },
    { userId: 'me', id: 'm1', format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'], fields: 'id,threadId,payload/headers' },
  ]);
  assert.deepEqual(await f.alerts(), [{ ts: '2026-10-30T00:00:00.000Z', account: 'tractic', tag: 'ALFRED',
    from: 'Alfred <alfred.gpt@ktagroupinc.com>', subject: 'Status update', message_id: 'm1', thread_id: 't1' }]);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'tractic.json'), 'utf8')), { historyId: '20' });
  assert.equal(f.logs.filter(line => JSON.parse(line).event === 'heartbeat').length, 1);
});

test('first start seeds from profile without fetching old messages', async () => {
  const f = await setup(false);
  await f.watcher.poll();
  assert.deepEqual(f.calls, [{ userId: 'me' }]);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'tractic.json'), 'utf8')), { historyId: '30' });
  assert.ok(f.logs.some(line => JSON.parse(line).event === 'seed'));
});

test('history 404 reseeds and logs an explicit gap', async () => {
  const f = await setup();
  f.gmail.users.history.list = async () => { throw { response: { status: 404 } }; };
  await f.watcher.poll();
  assert.deepEqual(f.calls, [{ userId: 'me' }]);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'tractic.json'), 'utf8')), { historyId: '30' });
  assert.ok(f.logs.some(line => JSON.parse(line).event === 'gap'));
});

test('paginates history, deduplicates message ids, and persists the final cursor', async () => {
  const f = await setup();
  const tokens: (string | undefined)[] = [];
  f.gmail.users.history.list = async params => {
    tokens.push(params.pageToken ?? undefined);
    return { data: { historyId: params.pageToken ? '22' : '21', nextPageToken: params.pageToken ? undefined : 'page2',
      history: [{ messagesAdded: [{ message: { id: 'm1' } }] }] } };
  };
  await f.watcher.poll();
  assert.deepEqual(tokens, [undefined, 'page2']);
  assert.equal((await f.alerts()).length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'tractic.json'), 'utf8')), { historyId: '22' });
});

test('five consecutive failures emit one ERROR; success resets the failure streak', async () => {
  const f = await setup();
  const success = f.gmail.users.history.list;
  f.gmail.users.history.list = async () => { throw new Error('offline'); };
  for (let i = 0; i < 4; i++) await f.watcher.poll();
  await assert.rejects(readFile(join(f.dir, 'alerts.jsonl')), { code: 'ENOENT' });
  await f.watcher.poll();
  await f.watcher.poll();
  assert.deepEqual((await f.alerts()).map(a => a.tag), ['ERROR']);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'tractic.json'), 'utf8')), { historyId: '10' });
  f.gmail.users.history.list = success;
  await f.watcher.poll();
  f.gmail.users.history.list = async () => { throw new Error('offline'); };
  for (let i = 0; i < 5; i++) await f.watcher.poll();
  assert.deepEqual((await f.alerts()).map(a => a.tag), ['ERROR', 'ALFRED', 'ERROR']);
});

test('invalid_grant from token loading immediately emits ERROR without leaking raw errors', async () => {
  const f = await setup();
  const watcher = new AccountWatcher('tractic', [rule], f.dir, async () => {
    throw new Error('Token refresh failed: invalid_grant SECRET');
  }, line => f.logs.push(line));
  await watcher.poll();
  await watcher.poll();
  const alerts = await f.alerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].tag, 'ERROR');
  assert.match(alerts[0].subject, /invalid_grant/);
  assert.doesNotMatch(JSON.stringify(alerts) + f.logs.join(''), /SECRET/);
});

test('metadata failure retains cursor; message 404 does not reseed the account', async () => {
  const f = await setup();
  f.gmail.users.messages.get = async () => { throw { code: 503 }; };
  await f.watcher.poll();
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'tractic.json'), 'utf8')), { historyId: '10' });
  f.gmail.users.messages.get = async () => { throw { code: 404 }; };
  await f.watcher.poll();
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'tractic.json'), 'utf8')), { historyId: '20' });
  assert.equal(f.logs.some(line => JSON.parse(line).event === 'gap'), false);
});
