import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { gmail_v1 } from 'googleapis';
import {
  collectDigest, formatHonolulu, isPersonMessage, loadDigestIgnorePatterns, loadDigestRules, parseDigestArgs, parseDigestConfig,
  renderDigest, runDigest, sendDigest, threadForDigest,
  type DigestEmail, type DigestSendGmail, type ReadonlyDigestGmail,
} from '../src/alerts/mail-digest.js';

const now = Date.parse('2026-11-11T22:00:00Z');
const since = now - 86_400_000;
const source = { alias: 'fixture-a', email: 'source@example.invalid' };
const destination = { alias: 'fixture-b', email: 'digest@example.invalid' };
const extra = { alias: 'fixture-c', email: 'extra@example.invalid' };
const config = () => parseDigestConfig({
  DIGEST_TO: destination.email, DIGEST_FROM: source.email, DIGEST_SKIP_ACCOUNTS: '',
});
const rule = { account: source.alias, from: ['routed@example.invalid'], subject_contains: ['status'], tag: 'FIXTURE' };
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true });
});
async function scratch() {
  const dir = await mkdtemp(join(process.cwd(), '.mail-digest-test-'));
  directories.push(dir);
  return dir;
}

function message(from = 'Contributor <sender@example.invalid>', time = now - 60_000,
  headers: { name: string; value: string }[] = []): gmail_v1.Schema$Message {
  return { id: 'message-1', internalDate: String(time), snippet: 'Please review the proposal.\nA response would help.',
    payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: 'Proposal' }]
      .filter(h => !headers.some(override => override.name.toLowerCase() === h.name.toLowerCase())).concat(headers) } };
}
function thread(messages = [message()], id = 'thread-1'): gmail_v1.Schema$Thread { return { id, messages }; }
function candidate(messages: gmail_v1.Schema$Message[], owners = new Set([source.email]), rules = [rule],
  ignorePatterns: import('../src/alerts/mail-digest.js').DigestIgnorePattern[] = []) {
  return threadForDigest(thread(messages), source.alias, owners, rules, since, now, ignorePatterns);
}

function fake(threads = [thread()], aliases: string[] = []) {
  const listCalls: gmail_v1.Params$Resource$Users$Threads$List[] = [];
  const getCalls: gmail_v1.Params$Resource$Users$Threads$Get[] = [];
  let aliasReads = 0;
  const gmail: ReadonlyDigestGmail = { users: {
    threads: {
      list: async params => { listCalls.push(params); return { data: { threads: threads.map(t => ({ id: t.id })) } }; },
      get: async params => { getCalls.push(params); return { data: threads.find(t => t.id === params.id)! }; },
    },
    settings: { sendAs: { list: async () => {
      aliasReads++;
      return { data: { sendAs: aliases.map(sendAsEmail => ({ sendAsEmail })) } };
    } } },
  } };
  return { gmail, listCalls, getCalls, aliasReads: () => aliasReads };
}
function sender(fail = false) {
  const calls: gmail_v1.Params$Resource$Users$Messages$Send[] = [];
  const gmail: DigestSendGmail = { users: { messages: { send: async params => {
    calls.push(params);
    if (fail) throw new Error('synthetic provider failure');
    return { data: { id: 'sent-1' } };
  } } } };
  return { gmail, calls };
}
const email: DigestEmail = { subject: '[Mail digest] Nov 11 Midday — 1 threads', body: 'A plain text digest.', count: 1 };

test('requires all env keys, accepts an explicitly empty skip list, and always skips the recipient', () => {
  assert.throws(() => parseDigestConfig({}), /DIGEST_TO/);
  const env = { DIGEST_TO: destination.email, DIGEST_FROM: source.email, DIGEST_SKIP_ACCOUNTS: '' };
  for (const key of Object.keys(env)) {
    const missing: NodeJS.ProcessEnv = { ...env };
    delete missing[key];
    assert.throws(() => parseDigestConfig(missing), /Set DIGEST/);
  }
  for (const value of ['', ' ', 'two@example.invalid,other@example.invalid', 'Name <one@example.invalid>', 'one@example.invalid\r\nBcc: other@example.invalid']) {
    assert.throws(() => parseDigestConfig({ ...env, DIGEST_TO: value }));
    assert.throws(() => parseDigestConfig({ ...env, DIGEST_FROM: value }));
  }
  assert.deepEqual([...config().skipAccounts], [destination.email]);
  assert.deepEqual([...parseDigestConfig({ ...env, DIGEST_SKIP_ACCOUNTS: ' fixture-c, EXTRA@example.invalid ' }).skipAccounts],
    ['fixture-c', extra.email, destination.email]);
});

test('CLI defaults to dry run and refuses conflicting or unknown flags', () => {
  assert.deepEqual(parseDigestArgs([]), { send: false });
  assert.deepEqual(parseDigestArgs(['--dry-run']), { send: false });
  assert.deepEqual(parseDigestArgs(['--send']), { send: true });
  for (const args of [['--send', '--dry-run'], ['--unknown'], ['--to', 'other@example.invalid']]) {
    assert.throws(() => parseDigestArgs(args), /Usage/);
  }
});

test('person heuristic accepts human mail and excludes automated local parts, services, and list headers', () => {
  assert.ok(isPersonMessage(message()));
  assert.ok(isPersonMessage(message('sender@example.invalid')));
  assert.ok(isPersonMessage(message('sender@example.invalid', undefined, [{ name: 'Auto-Submitted', value: 'no' }])));
  for (const local of ['noreply', 'no-reply', 'no_reply', 'do-not-reply', 'notifications', 'notification', 'mailer-daemon',
    'postmaster', 'bounce', 'newsletter', 'automated', 'alerts', 'receipts', 'build-bot', 'github', 'slack', 'vercel', 'supabase', 'stripe']) {
    assert.equal(isPersonMessage(message(`${local}@example.invalid`)), false, local);
  }
  for (const local of ['NOREPLY', 'No-Reply', 'Notifications', 'Notification', 'Mailer-Daemon', 'alerts']) {
    assert.equal(isPersonMessage(message(`${local}+tag@example.invalid`)), false, local);
  }
  for (const service of ['github', 'slack', 'vercel', 'supabase', 'stripe']) {
    assert.equal(isPersonMessage(message(`updates@${service}.example.invalid`)), false, service);
    assert.equal(isPersonMessage(message(`${service} <updates@example.invalid>`)), false, service);
  }
  for (const h of [
    { name: 'lIsT-uNsUbScRiBe', value: '<https://example.invalid/unsubscribe>' },
    { name: 'List-Unsubscribe', value: '' }, { name: 'List-Id', value: 'news.example.invalid' },
    { name: 'Auto-Submitted', value: 'auto-generated' }, { name: 'Precedence', value: 'bulk' },
  ]) assert.equal(isPersonMessage(message(undefined, undefined, [h])), false, h.name);
  for (const invalid of ['', 'not-an-address', 'one@example.invalid,two@example.invalid', '<one@example.invalid>, <two@example.invalid>']) {
    assert.equal(isPersonMessage(message(invalid)), false);
  }
});

test('latest received message wins regardless of array order, subject Date header, or thread snippet', () => {
  const own = message(source.email, now - 1_000);
  const human = message(undefined, now - 2_000);
  assert.equal(candidate([own, human]), undefined);
  assert.equal(candidate([human, own]), undefined);
  assert.ok(candidate([message(source.email, now - 3_000), human]));
  const actual = candidate([message(undefined, now - 4_000, [{ name: 'Date', value: 'invalid' }]), human]);
  assert.equal(actual?.time, now - 2_000);
  assert.equal(actual?.snippet, 'Please review the proposal. A response would help.');
  assert.equal(candidate([message('OTHER@example.invalid')], new Set(['other@example.invalid'])), undefined);
  const draft = { ...message(source.email, now), labelIds: ['DRAFT'] };
  assert.ok(candidate([human, draft]));
  assert.equal(candidate([draft]), undefined);
  assert.equal(candidate([]), undefined);
  assert.throws(() => candidate([{ ...human, internalDate: 'invalid' }]), /received time/);
});

test('ignore patterns match exact addresses, domains and subject prefixes case-insensitively', () => {
  const patterns = [
    { kind: 'address' as const, value: 'alerts@example.invalid' },
    { kind: 'domain' as const, value: 'mail.example.invalid' },
    { kind: 'subject' as const, value: 'successfully published' },
  ];
  assert.equal(candidate([message('alerts@example.invalid')], new Set(), [], patterns), undefined);
  assert.equal(candidate([message('sender@sub.mail.example.invalid')], new Set(), [], patterns), undefined);
  assert.equal(candidate([message(undefined, undefined, [{ name: 'Subject', value: 'Successfully Published package' }])], new Set(), [], patterns), undefined);
  assert.ok(candidate([message('sender@example.invalid')], new Set(), [], patterns));
});

test('ignore file parser and loader handle all pattern kinds, comments and missing file', async () => {
  const dir = await scratch();
  const path = join(dir, 'ignore.txt');
  assert.deepEqual(await loadDigestIgnorePatterns(path), []);
  await writeFile(path, '# local exclusions\nalerts@example.invalid\n@mail.example.invalid\nsubject:Successfully published\n');
  assert.deepEqual(await loadDigestIgnorePatterns(path), [
    { kind: 'address', value: 'alerts@example.invalid' },
    { kind: 'domain', value: 'mail.example.invalid' },
    { kind: 'subject', value: 'successfully published' },
  ]);
});

test('decodes named and numeric HTML entities in subjects and snippets', () => {
  const sourceMessage = message(undefined, now - 1_000, [
    { name: 'Subject', value: 'It&#39;s &quot;ready&quot; &amp; done' },
  ]);
  sourceMessage.snippet = 'It&#39;s &amp; &#34;ready&#34;';
  const item = candidate([sourceMessage])!;
  const rendered = renderDigest([{ account: source, threads: [item] }], now);
  assert.match(rendered.body, /Subject: It's "ready" & done/);
  assert.match(rendered.body, /It's & "ready"/);
});

test('excludes Muse, automated mail, owner aliases, stale activity, future activity, and watcher rule matches', () => {
  assert.equal(candidate([message(undefined, undefined, [{ name: 'Subject', value: '[Muse] Report' }])]), undefined);
  assert.equal(candidate([message('routed@example.invalid', undefined, [{ name: 'Subject', value: 'New STATUS report' }])]), undefined);
  assert.ok(candidate([message('routed@example.invalid')], new Set(), [rule]));
  assert.ok(candidate([message('routed@example.invalid', undefined, [{ name: 'Subject', value: 'status' }])], new Set(), [{ ...rule, account: extra.alias }]));
  assert.equal(candidate([message('noreply@example.invalid')]), undefined);
  assert.equal(candidate([message('alias@example.invalid')], new Set(['alias@example.invalid'])), undefined);
  assert.equal(candidate([message(undefined, since)]), undefined);
  assert.equal(candidate([message(undefined, since - 1)]), undefined);
  assert.equal(candidate([message(undefined, now + 1)]), undefined);
  assert.ok(candidate([message(undefined, now)]));
});

test('collects all pages, deduplicates threads, fetches metadata only, and includes skipped-account aliases among owners', async () => {
  const a = fake([thread(), thread([message('other-alias@example.invalid')], 'thread-2')]);
  const b = fake([], ['other-alias@example.invalid']);
  const c = fake();
  a.gmail.users.threads.list = async params => {
    a.listCalls.push(params);
    return { data: { threads: params.pageToken ? [{ id: 'thread-1' }, { id: 'thread-2' }] : [{ id: 'thread-1' }],
      nextPageToken: params.pageToken ? undefined : 'page-2' } };
  };
  const cfg = config();
  cfg.skipAccounts.add(extra.alias);
  const groups = await collectDigest({ accounts: [source, destination, extra], config: cfg, rules: [], since, now,
    client: async account => account === source ? a.gmail : account === destination ? b.gmail : c.gmail });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].threads.map(t => t.id), ['thread-1']);
  assert.equal(a.aliasReads(), 1);
  assert.equal(b.aliasReads(), 1);
  assert.equal(c.aliasReads(), 1);
  assert.equal(b.listCalls.length, 0);
  assert.equal(c.listCalls.length, 0);
  assert.deepEqual(a.listCalls.map(p => p.pageToken), [undefined, 'page-2']);
  assert.match(a.listCalls[0].q!, /^after:\d+ before:\d+$/);
  assert.equal(a.getCalls.length, 2);
  assert.equal(a.getCalls[0].format, 'metadata');
  assert.ok(a.getCalls[0].metadataHeaders?.includes('List-Unsubscribe'));
  assert.match(a.getCalls[0].fields!, /internalDate/);
});

test('thread deletion during collection is tolerated; other read failures abort', async () => {
  const f = fake();
  f.gmail.users.threads.get = async () => { throw { response: { status: 404 } }; };
  const options = { accounts: [source], config: config(), rules: [], since, now, client: async () => f.gmail };
  assert.equal((await collectDigest(options))[0].threads.length, 0);
  f.gmail.users.threads.get = async () => { throw { code: 403 }; };
  await assert.rejects(collectDigest(options));
  f.gmail.users.settings.sendAs.list = async () => { throw new Error('alias read failed'); };
  await assert.rejects(collectDigest(options), /alias read failed/);
});

test('renders one grouped digest with counts, sender, snippet, encoded Gmail links, and Honolulu am/pm', () => {
  const item = candidate([message()])!;
  const rendered = renderDigest([{ account: source, threads: [item] }, { account: extra, threads: [item] }], now);
  assert.equal(rendered.count, 2);
  assert.equal(rendered.subject, '[Mail digest] Nov 11 Midday — 2 threads');
  for (const value of ['source@example.invalid: 1; extra@example.invalid: 1', 'From: Contributor <sender@example.invalid>',
    'Subject: Proposal', 'Received: Nov 11, 11:59 am', 'Please review the proposal.',
    'https://mail.google.com/mail/u/?authuser=source%40example.invalid#all/thread-1']) assert.ok(rendered.body.includes(value), value);
  assert.equal(formatHonolulu(Date.parse('2026-11-11T09:05:00Z')), 'Nov 10, 11:05 pm');
  assert.equal(formatHonolulu(Date.parse('2026-11-11T10:00:00Z')), 'Nov 11, 12:00 am');
  assert.match(renderDigest([], Date.parse('2026-11-11T20:00:00Z')).subject, /Nov 11 AM/);
  assert.match(renderDigest([], Date.parse('2026-11-12T01:00:00Z')).subject, /Nov 11 PM/);
  assert.doesNotMatch(rendered.body, /\d{2}:\d{2}:\d{2}Z/);
});

test('sender guards the only recipient, constructs plain UTF-8 mail, and makes exactly one send', async () => {
  const f = sender();
  let loads = 0;
  const client = async () => { loads++; return f.gmail; };
  for (const recipient of ['other@example.invalid', `${destination.email},other@example.invalid`,
    `${destination.email}\r\nBcc: other@example.invalid`, `Display <${destination.email}>`]) {
    await assert.rejects(sendDigest(config(), recipient, email, client));
  }
  assert.equal(loads, 0);
  await sendDigest(config(), destination.email.toUpperCase(), email, client);
  assert.equal(f.calls.length, 1);
  const raw = Buffer.from(f.calls[0].requestBody!.raw!, 'base64url').toString();
  assert.match(raw, /^From: source@example.invalid\r\nTo: digest@example.invalid\r\n/);
  assert.match(raw, /Content-Type: text\/plain; charset=UTF-8/);
  assert.doesNotMatch(raw, /^(Cc|Bcc|Reply-To):/im);
  assert.equal(Buffer.from(raw.split('\r\n\r\n')[1], 'base64').toString(), email.body);
  const subject = raw.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)![1];
  assert.equal(Buffer.from(subject, 'base64').toString(), email.subject);
  const failed = sender(true);
  await assert.rejects(sendDigest(config(), destination.email, email, async () => failed.gmail));
  assert.equal(failed.calls.length, 1);
});

test('empty digest never loads the sending client', async () => {
  await sendDigest(config(), destination.email, { ...email, count: 0 }, async () => { throw new Error('must not load'); });
});

test('default dry run renders only and leaves the state directory absent', async () => {
  const root = await scratch();
  const stateDirectory = join(root, 'state');
  const f = fake();
  const output: string[] = [];
  const result = await runDigest({ config: config(), accounts: [source], rules: [], stateDirectory, now,
    client: async () => f.gmail, sendClient: async () => { throw new Error('must not send'); }, output: text => output.push(text) });
  assert.equal(result.count, 1);
  assert.equal(output.length, 1);
  assert.match(output[0], /^From: source@example.invalid\nTo: digest@example.invalid\nSubject: \[Mail digest\]/);
  await assert.rejects(readFile(join(stateDirectory, 'state.json')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(root), []);
  assert.equal(f.listCalls[0].q, `after:${Math.floor((since - 1) / 1000)} before:${Math.floor(now / 1000) + 1}`);
});

test('dry run does not advance existing state, and empty preview produces no email', async () => {
  const stateDirectory = await scratch();
  const lastDigest = now - 2_000;
  const statePath = join(stateDirectory, 'state.json');
  const original = JSON.stringify({ lastDigest });
  await writeFile(statePath, original);
  const f = fake([thread([message(undefined, now - 3_000)])]);
  const output: string[] = [];
  const result = await runDigest({ config: config(), accounts: [source], rules: [], stateDirectory, now,
    client: async () => f.gmail, sendClient: async () => { throw new Error('must not send'); }, output: text => output.push(text) });
  assert.equal(result.count, 0);
  assert.deepEqual(output, []);
  assert.equal(await readFile(statePath, 'utf8'), original);
  assert.equal(f.listCalls[0].q, `after:${Math.floor((lastDigest - 1) / 1000)} before:${Math.floor(now / 1000) + 1}`);
});

test('send mode sends one combined email, then persists the window and releases the lock', async () => {
  const stateDirectory = await scratch();
  const f = fake();
  const sent = sender();
  const loaded: string[] = [];
  const result = await runDigest({ config: config(), accounts: [source, destination, extra], rules: [], stateDirectory, now, send: true,
    client: async () => f.gmail, sendClient: async account => { loaded.push(account.email); return sent.gmail; } });
  assert.equal(result.count, 2);
  assert.deepEqual(loaded, [source.email]);
  assert.equal(sent.calls.length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8')), { lastDigest: now });
  assert.deepEqual(await readdir(stateDirectory), ['state.json']);
});

test('successful empty scan advances the window without sending', async () => {
  const stateDirectory = await scratch();
  const f = fake([]);
  const result = await runDigest({ config: config(), accounts: [source], rules: [], stateDirectory, now, send: true,
    client: async () => f.gmail, sendClient: async () => { throw new Error('must not send'); } });
  assert.equal(result.count, 0);
  assert.deepEqual(JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8')), { lastDigest: now });
});

test('read/send failures preserve state and release the lock', async () => {
  const stateDirectory = await scratch();
  const statePath = join(stateDirectory, 'state.json');
  const original = JSON.stringify({ lastDigest: since });
  await writeFile(statePath, original);
  const f = fake();
  const sent = sender(true);
  const options = { config: config(), accounts: [source], rules: [], stateDirectory, now, send: true,
    client: async () => f.gmail, sendClient: async () => sent.gmail };
  await assert.rejects(runDigest(options), /provider failure/);
  assert.equal(await readFile(statePath, 'utf8'), original);
  assert.deepEqual(await readdir(stateDirectory), ['state.json']);
  f.gmail.users.threads.list = async () => { throw new Error('read failed'); };
  await assert.rejects(runDigest(options), /read failed/);
  assert.equal(sent.calls.length, 1);
  assert.equal(await readFile(statePath, 'utf8'), original);
});

test('rejects concurrent sends, corrupt/future state, and an unconfigured sending address', async () => {
  const stateDirectory = await scratch();
  const f = fake();
  const options = { config: config(), accounts: [source], rules: [], stateDirectory, now, send: true,
    client: async () => f.gmail, sendClient: async () => { throw new Error('must not send'); } };
  await writeFile(join(stateDirectory, 'run.lock'), '');
  await assert.rejects(runDigest(options), { code: 'EEXIST' });
  assert.equal(f.aliasReads(), 0);
  await rm(join(stateDirectory, 'run.lock'));
  for (const state of ['bad json', JSON.stringify({ lastDigest: now + 1 }), JSON.stringify({ lastDigest: '123' })]) {
    await writeFile(join(stateDirectory, 'state.json'), state);
    await assert.rejects(runDigest(options));
  }
  await assert.rejects(runDigest({ ...options, config: { ...config(), from: 'other@example.invalid' } }), /configured account/);
  assert.equal(f.aliasReads(), 0);
});

test('rules loader shares watcher validation, tolerates absent rules, and rejects malformed rules', async () => {
  const dir = await scratch();
  const path = join(dir, 'rules.json');
  assert.deepEqual(await loadDigestRules(path), []);
  await writeFile(path, JSON.stringify([rule]));
  assert.deepEqual(await loadDigestRules(path), [rule]);
  for (const value of ['bad json', '[]', JSON.stringify([{ ...rule, from: [] }])]) {
    await writeFile(path, value);
    await assert.rejects(loadDigestRules(path));
  }
});
