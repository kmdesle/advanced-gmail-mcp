import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { gmail_v1 } from 'googleapis';
import { runMuseWatch, parseArgs, webhookPoster, type Notice, type ReadonlyMuseGmail } from '../src/alerts/muse-watch.js';
import { parseWebhookConfig } from '../src/alerts/watcher.js';

const account = 'kevin@cyberwingman.ai';
const muse = 'kevin.m.desler@gmail.com';
const time = (s: string) => Date.parse(`2026-11-08T${s}:00Z`);
function mail(id: string, subject: string, at: number, options: { from?: string; to?: string; body?: string; labels?: string[] } = {}): gmail_v1.Schema$Message {
  return { id, internalDate: String(at), labelIds: options.labels ?? [], payload: { mimeType: 'text/plain',
    headers: [{ name: 'Subject', value: subject }, { name: 'From', value: options.from ?? muse }, { name: 'To', value: options.to ?? account }],
    body: { data: Buffer.from(options.body ?? 'report').toString('base64url') } } };
}
async function harness(t: Parameters<Parameters<typeof test>[1]>[0], checkedThrough = time('17:00')) {
  const directory = await mkdtemp(join(homedir(), '.muse-watch-test-'));
  t.after(() => rm(directory, { recursive: true }));
  const statePath = join(directory, 'state.json');
  await writeFile(statePath, JSON.stringify({ version: 1, checkedThrough, alerts: {} }));
  let messages: gmail_v1.Schema$Message[] = [];
  let failing = false;
  const posted: Notice[] = [];
  const gmail: ReadonlyMuseGmail = { users: {
    labels: { list: async () => ({ data: { labels: [{ id: 'muse-label', name: '[Muse]' }] } }) },
    messages: {
      list: async params => {
        if (failing) throw new Error('private provider diagnostic');
        assert.equal(params.userId, 'me');
        return { data: params.pageToken ? { messages: messages.slice(1).map(m => ({ id: m.id })) }
          : { messages: messages.slice(0, 1).map(m => ({ id: m.id })), ...(messages.length > 1 ? { nextPageToken: 'next' } : {}) } };
      },
      get: async params => { assert.equal(params.format, 'full'); return { data: messages.find(m => m.id === params.id)! }; },
    },
  } };
  return { posted, statePath, gmail, set: (m: gmail_v1.Schema$Message[]) => { messages = m; }, fail: (value: boolean) => { failing = value; },
    run: (now: number, dryRun = false, post = async (n: Notice) => { posted.push(n); }) => runMuseWatch({ gmail, post, statePath, now, dryRun }) };
}

test('missing slots alert once across restarts, recover once, and span UTC midnight', async t => {
  const h = await harness(t);
  assert.equal((await h.run(time('19:59'))).length, 0);
  assert.equal((await h.run(time('20:00')))[0].color, 'amber');
  assert.equal((await h.run(time('20:17'))).length, 0);
  h.set([mail('late', 'Muse Inflecto test latest', time('20:20'))]);
  assert.equal((await h.run(time('20:30')))[0].color, 'green');
  assert.equal((await h.run(time('20:40'))).length, 0);
  h.set([]);
  await h.run(time('23:00'));
  const next = await h.run(Date.parse('2026-11-09T02:00:00Z'));
  assert.ok(next.some(n => n.key === 'slot:2026-11-09T00:00:00.000Z'));
  assert.equal(h.posted.filter(n => n.key.includes('18:00')).length, 2);
});

test('report subject prefixes and received timestamps determine the two-hour window', async t => {
  for (const subject of ['Muse Inflecto test daily', '[Muse] Spec daily']) {
    const h = await harness(t);
    h.set([mail('r', subject, time('20:00'))]);
    assert.equal((await h.run(time('20:00'))).length, 0);
  }
  const h = await harness(t);
  h.set([mail('r', 'Re: Muse Inflecto test daily', time('19:00')),
    mail('out', '[Muse] Spec outgoing', time('19:00'), { from: account, to: muse })]);
  assert.equal((await h.run(time('20:00')))[0].color, 'amber');
});

test('orders use both allowed senders, label or prefix, exclusions, recipient and 15 minute deadline', async t => {
  const h = await harness(t);
  const first = mail('o1', '[Muse] Run task', time('17:00'), { from: account, to: muse });
  const second = mail('o2', 'Run other task', time('17:00'), { from: muse, to: muse, labels: ['muse-label'] });
  h.set([first, second,
    mail('excluded', '[Muse] Spec task', time('17:00'), { from: account, to: muse }),
    mail('wrong', '[Muse] Not an order to Muse', time('17:00'), { from: account, to: 'other@example.com' })]);
  assert.equal((await h.run(time('17:14'))).length, 0);
  assert.equal((await h.run(time('17:15'))).length, 2);
  assert.equal((await h.run(time('17:30'))).length, 0);
  h.set([first, second, mail('a1', '[Muse] Ack: [Muse] Run task', time('17:31')),
    mail('a2', '[Muse] Ack: Run other task', time('17:31'))]);
  assert.deepEqual((await h.run(time('17:40'))).map(n => n.color), ['green', 'green']);
  assert.equal((await h.run(time('17:50'))).length, 0);
});

test('old or unrelated acks cannot acknowledge a new order with the same subject', async t => {
  const h = await harness(t);
  h.set([mail('old', '[Muse] Ack: [Muse] Task', time('16:59')),
    mail('wrong', '[Muse] Ack: Task', time('17:05')),
    mail('order', '[Muse] Task', time('17:00'), { from: account, to: muse })]);
  assert.equal((await h.run(time('17:15')))[0].key, 'order:order');
});

test('HOLDING includes reason after status, on same or next line, and only later status recovers it', async t => {
  const h = await harness(t);
  const ack = mail('hold', '[Muse] Ack: [Muse] Task', time('17:00'), { body: 'Status: HOLDING\nReason: browser unavailable' });
  h.set([ack]);
  assert.match((await h.run(time('17:05')))[0].text, /^🟡 🔮 INFLECTO.*browser unavailable/);
  assert.equal((await h.run(time('17:10'))).length, 0);
  h.set([]);
  assert.equal((await h.run(time('17:15'))).length, 0);
  h.set([ack, mail('done', ack.payload!.headers![0].value!, time('17:20'), { body: 'Status: DONE' })]);
  assert.equal((await h.run(time('17:25')))[0].color, 'green');
  assert.equal((await h.run(time('17:30'))).length, 0);
  const same = await harness(t, time('17:00'));
  same.set([mail('same', '[Muse] Ack: Same', time('17:00'), { from: 'other@example.com', body: 'Received now Status: HOLDING Please confirm in this chat' })]);
  assert.match((await same.run(time('17:05')))[0].text, /Please confirm in this chat/);
  const long = await harness(t);
  long.set([mail('long', '[Muse] Ack: Long', time('17:00'), { from: 'other@example.com', body: `Status: HOLDING ${'x'.repeat(240)}` })]);
  assert.equal((await long.run(time('17:05')))[0].text.split('x'.repeat(200)).length, 2);
});

test('first evaluation ignores old order deadlines; initially recovered late reports do not alert', async t => {
  const directory = await mkdtemp(join(homedir(), '.muse-watch-test-'));
  t.after(() => rm(directory, { recursive: true }));
  const statePath = join(directory, 'new-state.json');
  const h = await harness(t, time('17:00'));
  // Re-run with a missing state file, matching the production seed path.
  h.set([mail('old-order', '[Muse] Old task', Date.parse('2026-11-07T18:00:00Z'), { from: account, to: muse }),
    mail('late-report', 'Muse Inflecto test late', time('19:00'))]);
  const seeded = await runMuseWatch({ gmail: h.gmail, post: async () => {}, statePath, now: time('20:30') });
  assert.ok(!seeded.some(n => n.key === 'order:old-order'));
  assert.ok(!seeded.some(n => n.color === 'green'));
  const active = await harness(t, time('17:00'));
  active.set([mail('late-report', 'Muse Inflecto test late', time('19:00'))]);
  const notices = await active.run(time('20:30'));
  assert.ok(!notices.some(n => n.key === 'slot:2026-11-08T18:00:00.000Z'));
});

test('webhook routing drops green and amber when their own destination is absent', async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => { calls.push(String(input)); return new Response('', { status: 200 }); };
  try {
    const post = webhookPoster({ SLACK_ALERTS_ACTION_WEBHOOK_URL: 'action' }, message => logs.push(message));
    await post({ key: 'g', color: 'green', text: 'green' });
    await post({ key: 'a', color: 'amber', text: 'amber' });
    assert.deepEqual(calls, []);
    assert.equal(logs.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('unknown source never recovers existing failures; source amber and recovery each post once', async t => {
  const h = await harness(t);
  await h.run(time('20:00'));
  h.fail(true);
  assert.equal((await h.run(time('20:10')))[0].key, 'source');
  assert.equal((await h.run(time('20:15'))).length, 0);
  h.fail(false);
  const recovered = await h.run(time('20:20'));
  assert.deepEqual(recovered.map(n => n.key), ['source']);
  assert.equal(JSON.parse(await readFile(h.statePath, 'utf8')).alerts['slot:2026-11-08T18:00:00.000Z'].active, true);
});

test('dry-run neither posts nor changes state; failed posts remain retryable', async t => {
  const h = await harness(t);
  const before = await readFile(h.statePath, 'utf8');
  assert.equal((await h.run(time('20:00'), true)).length, 1);
  assert.equal(h.posted.length, 0);
  assert.equal(await readFile(h.statePath, 'utf8'), before);
  await assert.rejects(h.run(time('20:00'), false, async () => { throw new Error('post failed'); }));
  assert.equal(await readFile(h.statePath, 'utf8'), before);
  assert.equal((await h.run(time('20:00'))).length, 1);
});

test('malformed state fails closed, argument parsing and shared fleet config', async t => {
  const h = await harness(t);
  await writeFile(h.statePath, '{}');
  await assert.rejects(h.run(time('20:00')), /Invalid Muse watch state/);
  assert.equal(h.posted.length, 0);
  assert.equal(parseArgs(['--dry-run']), true);
  assert.equal(parseArgs([]), false);
  assert.throws(() => parseArgs(['--apply']));
  assert.deepEqual(parseWebhookConfig("SLACK_ALERTS_WATCH_WEBHOOK_URL='fake-watch'"), { SLACK_ALERTS_WATCH_WEBHOOK_URL: 'fake-watch' });
});

test('a timely Ack suppresses amber; a late Ack records the missed deadline then recovery', async t => {
  for (const [minute, expected] of [['15', []], ['16', ['amber', 'green']]] as const) {
    const h = await harness(t);
    h.set([mail('o', '[Muse] Task', time('17:00'), { from: account, to: muse }),
      mail('a', '[Muse] Ack: [Muse] Task', time(`17:${minute}`))]);
    assert.deepEqual((await h.run(time('17:30'))).map(n => n.color), expected);
    assert.equal((await h.run(time('17:40'))).length, 0);
  }
});
