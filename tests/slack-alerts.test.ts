import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  createSlackClient, parseColor, parseOverrides, SlackApiError, SlackWatcher,
  type ReadonlySlack, type SlackChannel, type SlackMessage,
} from '../src/slack/watcher.js';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true });
});

const T0 = Date.parse('2026-10-31T12:00:00Z');
const ts = (offsetSeconds: number) => ((T0 + offsetSeconds * 1000) / 1000).toFixed(6);

async function setup(overrides = { exclude: [] as string[], tags: {} as Record<string, string> }) {
  const dir = await mkdtemp(join(process.cwd(), '.slack-alerts-test-'));
  directories.push(dir);
  let clock = T0;
  const state = {
    channels: [{ id: 'C1', name: 'fleet-red-action' }, { id: 'C2', name: 'general' }] as SlackChannel[],
    messages: {} as Record<string, SlackMessage[]>,
    historyCalls: [] as { channel: string; oldest: string }[],
    discoveryCalls: 0,
    fail: undefined as undefined | ((channel: string) => SlackApiError | undefined),
  };
  const client: ReadonlySlack = {
    async memberChannels() { state.discoveryCalls++; return { items: state.channels }; },
    async history(channel, oldest) {
      state.historyCalls.push({ channel, oldest });
      const error = state.fail?.(channel);
      if (error) throw error;
      return { items: (state.messages[channel] ?? []).filter(m => Number(m.ts) > Number(oldest)).reverse() };
    },
  };
  const logs: string[] = [];
  const sleeps: number[] = [];
  const watcher = new SlackWatcher(client, dir, overrides, l => logs.push(l), () => new Date(clock), async ms => { sleeps.push(ms); });
  const lines = async (file = 'alerts.jsonl') =>
    (await readFile(join(dir, file), 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { dir, state, watcher, logs, sleeps, lines, advance: (ms: number) => { clock += ms; } };
}

test('first run starts at now and appends only later messages in order, with color and tag', async () => {
  const s = await setup({ exclude: [], tags: { 'fleet-red-action': 'RED' } });
  s.state.messages.C1 = [{ ts: ts(-100), text: 'old', user: 'U0' }];
  await s.watcher.poll();
  await assert.rejects(s.lines(), { code: 'ENOENT' });
  s.advance(60_000);
  s.state.messages.C1.push(
    { ts: ts(20), text: '🟢 recovered', username: 'bot' },
    { ts: ts(10), text: '  🔴 disk full', bot_profile: { name: 'Monitor' }, thread_ts: ts(10) },
    { ts: ts(30), text: 'plain', user: 'U1' },
  );
  await s.watcher.poll();
  const out = await s.lines();
  assert.deepEqual(out.map(o => [o.tag, o.color, o.text, o.channel]), [
    ['RED', 'red', '  🔴 disk full', 'fleet-red-action'],
    ['RED', 'green', '🟢 recovered', 'fleet-red-action'],
    ['RED', null, 'plain', 'fleet-red-action'],
  ]);
  assert.equal(out[0].bot_name, 'Monitor');
  assert.equal(out[0].thread_ts, ts(10));
  assert.equal(out[2].user, 'U1');
  assert.equal(out[2].ts_iso, new Date(T0 + 60_000).toISOString());
  await s.watcher.poll();
  assert.equal((await s.lines()).length, 3, 'no duplicates on the next poll');
});

test('default tag is the channel name; excluded channels are skipped; text capped at 500', async () => {
  const s = await setup({ exclude: ['general'], tags: {} });
  await s.watcher.poll();
  s.advance(1000);
  s.state.messages.C1 = [{ ts: ts(0.5), text: 'x'.repeat(900), user: 'U' }];
  s.state.messages.C2 = [{ ts: ts(0.6), text: 'hidden', user: 'U' }];
  await s.watcher.poll();
  const out = await s.lines();
  assert.equal(out.length, 1);
  assert.equal(out[0].tag, 'fleet-red-action');
  assert.equal(out[0].text.length, 500);
  assert.ok(s.state.historyCalls.every(c => c.channel !== 'C2'));
});

test('state persists across watcher instances', async () => {
  const s = await setup();
  await s.watcher.poll();
  s.advance(1000);
  s.state.messages.C1 = [{ ts: ts(0.5), text: 'one', user: 'U' }];
  await s.watcher.poll();
  const saved = JSON.parse(await readFile(join(s.dir, 'state.json'), 'utf8'));
  assert.equal(saved.channels.C1, ts(0.5));
  const second = new SlackWatcher({
    memberChannels: async () => ({ items: s.state.channels }),
    history: async (c, oldest) => { s.state.historyCalls.push({ channel: c, oldest }); return { items: [] }; },
  }, s.dir, undefined, () => {}, () => new Date(T0 + 2000));
  await second.poll();
  assert.equal(s.state.historyCalls.findLast(c => c.channel === 'C1')?.oldest, ts(0.5));
  assert.equal((await s.lines()).length, 1);
});

test('channels are rediscovered every 15 minutes; newly joined channels start at now', async () => {
  const s = await setup();
  await s.watcher.poll();
  assert.equal(s.state.discoveryCalls, 1);
  s.advance(14 * 60_000);
  await s.watcher.poll();
  assert.equal(s.state.discoveryCalls, 1);
  s.state.channels.push({ id: 'C3', name: 'new-site' });
  s.state.messages.C3 = [{ ts: ts(1), text: 'before join seen', user: 'U' }];
  s.advance(60_000);
  await s.watcher.poll();
  assert.equal(s.state.discoveryCalls, 2);
  s.advance(1000);
  s.state.messages.C3.push({ ts: ts(14 * 60 + 100), text: 'after', user: 'U' });
  await s.watcher.poll();
  assert.deepEqual((await s.lines()).map(o => o.text), ['after']);
});

test('ERROR lines are throttled to one per distinct error per hour', async () => {
  const s = await setup();
  await s.watcher.poll();
  s.state.fail = c => (c === 'C1' ? new SlackApiError('channel_not_found') : undefined);
  await s.watcher.poll();
  s.advance(60_000);
  await s.watcher.poll();
  let out = await s.lines();
  assert.deepEqual(out.map(o => [o.ERROR, o.channel]), [['channel_not_found', 'fleet-red-action']]);
  assert.ok(out[0].ts_iso);
  s.state.fail = c => (c === 'C1' ? new SlackApiError('internal_error') : undefined);
  await s.watcher.poll();
  assert.equal((await s.lines()).length, 2, 'a different error is reported');
  s.state.fail = c => (c === 'C1' ? new SlackApiError('channel_not_found') : undefined);
  s.advance(61 * 60_000);
  await s.watcher.poll();
  assert.equal((await s.lines()).length, 3, 'reported again after an hour');
});

test('429 pauses polling until Retry-After and is not written as ERROR', async () => {
  const s = await setup();
  await s.watcher.poll();
  s.advance(1000);
  s.state.messages.C1 = [{ ts: ts(0.5), text: 'late', user: 'U' }];
  let limited = true;
  s.state.fail = () => (limited ? new SlackApiError('ratelimited', 120) : undefined);
  await s.watcher.poll();
  const calls = s.state.historyCalls.length;
  limited = false;
  s.advance(119_000);
  await s.watcher.poll();
  assert.equal(s.state.historyCalls.length, calls, 'no requests during Retry-After');
  s.advance(2000);
  await s.watcher.poll();
  assert.deepEqual((await s.lines()).map(o => o.text), ['late']);
});

test('backfill covers all member channels in the window, honors 429, and writes a dated file', async () => {
  const s = await setup({ exclude: ['skipme'], tags: { general: 'GEN' } });
  s.state.channels.push({ id: 'C9', name: 'skipme' });
  s.state.messages.C1 = [{ ts: ts(-3 * 86400), text: 'too old' }, { ts: ts(-3600), text: '🟡 recent', user: 'U' }];
  s.state.messages.C2 = [{ ts: ts(-7200), text: 'gen', user: 'U' }];
  s.state.messages.C9 = [{ ts: ts(-60), text: 'excluded', user: 'U' }];
  let first = true;
  s.state.fail = c => { if (c === 'C2' && first) { first = false; return new SlackApiError('ratelimited', 7); } };
  const file = await s.watcher.backfill(2);
  assert.equal(file, 'backfill-2026-10-31.jsonl');
  assert.deepEqual(s.sleeps, [7000]);
  const out = await s.lines(file);
  assert.deepEqual(out.map(o => [o.channel, o.tag, o.text, o.color]), [
    ['fleet-red-action', 'fleet-red-action', '🟡 recent', 'amber'],
    ['general', 'GEN', 'gen', null],
  ]);
  assert.equal(s.state.historyCalls[0].oldest, ts(-2 * 86400));
  assert.ok((await readdir(s.dir)).every(f => f !== 'state.json'), 'backfill does not touch loop state');
});

test('token never appears in logs, state, or output files, even on failures', async () => {
  const token = 'xoxb-secret-token-123';
  const s = await setup();
  const requests: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, auth: new Headers(init.headers).get('authorization') });
    return new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 });
  }) as unknown as typeof fetch;
  const watcher = new SlackWatcher(createSlackClient(token, fetchImpl), s.dir, undefined, l => s.logs.push(l), () => new Date(T0));
  await watcher.poll();
  assert.equal(requests[0].auth, `Bearer ${token}`);
  assert.ok(requests[0].url.startsWith('https://slack.com/api/users.conversations?'));
  assert.ok(!requests[0].url.includes(token));
  const output = s.logs.join('\n') + (await Promise.all((await readdir(s.dir)).map(f => readFile(join(s.dir, f), 'utf8')))).join('\n');
  assert.ok(!output.includes(token));
  assert.match(output, /invalid_auth/);
});

test('client maps 429 Retry-After and only uses read endpoints', async () => {
  const methods: string[] = [];
  const fetchImpl = (async (url: string) => {
    methods.push(new URL(url).pathname);
    return new Response('', { status: 429, headers: { 'retry-after': '42' } });
  }) as unknown as typeof fetch;
  const client = createSlackClient('t', fetchImpl);
  await assert.rejects(client.history('C1', '1'), (e: SlackApiError) => e.code === 'ratelimited' && e.retryAfterSeconds === 42);
  await assert.rejects(client.memberChannels(), (e: SlackApiError) => e.retryAfterSeconds === 42);
  assert.deepEqual(methods, ['/api/conversations.history', '/api/users.conversations']);
});

test('parseColor and parseOverrides', () => {
  assert.equal(parseColor('🔴 x'), 'red');
  assert.equal(parseColor('🟡x'), 'amber');
  assert.equal(parseColor('x 🔴'), null);
  assert.deepEqual(parseOverrides({}), { exclude: [], tags: {} });
  assert.throws(() => parseOverrides([]));
  assert.throws(() => parseOverrides({ tags: { a: 1 } }));
});
