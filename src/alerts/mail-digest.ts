#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { gmail_v1 } from 'googleapis';
import type { AccountConfig } from '../config.js';
import { matchesRule, parseRules, type Rule } from './watcher.js';

// Deliberately expose reads separately from the single permitted Gmail write.
export interface ReadonlyDigestGmail {
  users: {
    threads: {
      list(params: gmail_v1.Params$Resource$Users$Threads$List): Promise<{ data: gmail_v1.Schema$ListThreadsResponse }>;
      get(params: gmail_v1.Params$Resource$Users$Threads$Get): Promise<{ data: gmail_v1.Schema$Thread }>;
    };
    settings: { sendAs: {
      list(params: gmail_v1.Params$Resource$Users$Settings$Sendas$List): Promise<{ data: gmail_v1.Schema$ListSendAsResponse }>;
    } };
  };
}

export interface DigestSendGmail {
  users: { messages: {
    send(params: gmail_v1.Params$Resource$Users$Messages$Send): Promise<{ data: gmail_v1.Schema$Message }>;
  } };
}

export interface DigestConfig {
  to: string;
  from: string;
  skipAccounts: Set<string>;
}

export interface DigestThread {
  id: string;
  messageId: string;
  from: string;
  subject: string;
  time: number;
  snippet: string;
}

export interface DigestSelectionThread {
  account: string;
  thread_id: string;
  message_id: string;
  subject: string;
  from_name: string;
  received_at: string;
}

export interface DigestSelection {
  generated_at: string;
  window_start: string;
  window_end: string;
  threads: DigestSelectionThread[];
}

export interface DigestGroup { account: AccountConfig; threads: DigestThread[] }
export interface DigestEmail { subject: string; body: string; count: number }

const addressPattern = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/;
function address(value: string): string {
  if (!addressPattern.test(value)) throw new Error('Expected a single bare email address');
  return value.toLowerCase();
}

export function parseDigestConfig(env: NodeJS.ProcessEnv): DigestConfig {
  if (!env.DIGEST_TO?.trim() || !env.DIGEST_FROM?.trim() || env.DIGEST_SKIP_ACCOUNTS === undefined) {
    throw new Error('Set DIGEST_TO, DIGEST_FROM, and DIGEST_SKIP_ACCOUNTS (which may be empty)');
  }
  const to = address(env.DIGEST_TO.trim());
  const from = address(env.DIGEST_FROM.trim());
  const skipAccounts = new Set(env.DIGEST_SKIP_ACCOUNTS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  skipAccounts.add(to);
  return { to, from, skipAccounts };
}

export function digestSelectionOutPath(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.DIGEST_SELECTION_OUT?.trim();
  return value || undefined;
}

/** Display name only. A bare address, or any name that still contains one, becomes empty. */
export function digestFromName(from: string): string {
  const named = from.match(/^(.*?)<[^<>]*>\s*$/);
  const name = (named ? named[1] : from).trim().replace(/^"(.*)"$/, '$1').trim();
  if (!name || name.includes('@')) return '';
  return name;
}

export function digestSelection(groups: DigestGroup[], since: number, now: number): DigestSelection {
  return {
    generated_at: new Date(now).toISOString(),
    window_start: new Date(since).toISOString(),
    window_end: new Date(now).toISOString(),
    threads: groups.flatMap(group => group.threads.map(thread => ({
      account: group.account.alias,
      thread_id: thread.id,
      message_id: thread.messageId,
      subject: thread.subject,
      from_name: digestFromName(thread.from),
      received_at: new Date(thread.time).toISOString(),
    }))),
  };
}

export async function writeDigestSelection(targetPath: string, document: DigestSelection): Promise<void> {
  const temp = join(dirname(targetPath), `.digest-selection-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(temp, JSON.stringify(document) + '\n', { mode: 0o640 });
  await chmod(temp, 0o640);
  try {
    await rename(temp, targetPath);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export function parseDigestArgs(args: string[]): { send: boolean } {
  if (args.length > 1 || args.some(arg => arg !== '--send' && arg !== '--dry-run')) {
    throw new Error('Usage: mail-digest [--dry-run | --send]');
  }
  return { send: args[0] === '--send' };
}

function header(message: gmail_v1.Schema$Message, name: string): string {
  return message.payload?.headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function mailbox(from: string): string {
  const value = (from.match(/^[^<>]*<([^<>]+)>\s*$/)?.[1] ?? from).trim().toLowerCase();
  return addressPattern.test(value) ? value : '';
}

function oneLine(value: string): string { return value.replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim(); }

export type DigestIgnorePattern = { kind: 'address' | 'domain' | 'subject'; value: string };

export function parseDigestIgnorePatterns(value: string): DigestIgnorePattern[] {
  const patterns: DigestIgnorePattern[] = [];
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.toLowerCase().startsWith('subject:')) {
      const prefix = line.slice('subject:'.length).trim();
      if (prefix) patterns.push({ kind: 'subject', value: prefix.toLowerCase() });
    } else if (line.startsWith('@')) {
      const domain = line.slice(1).toLowerCase();
      if (!domain || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) {
        throw new Error(`Invalid mail-digest ignore domain: ${line}`);
      }
      patterns.push({ kind: 'domain', value: domain });
    } else {
      if (!addressPattern.test(line)) throw new Error(`Invalid mail-digest ignore address: ${line}`);
      patterns.push({ kind: 'address', value: line.toLowerCase() });
    }
  }
  return patterns;
}

export async function loadDigestIgnorePatterns(path = join(homedir(), '.config/mail-digest/ignore.txt')): Promise<DigestIgnorePattern[]> {
  let value: string;
  try { value = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return parseDigestIgnorePatterns(value);
}

function ignoredByLocalPatterns(from: string, subject: string, patterns: DigestIgnorePattern[]): boolean {
  const email = mailbox(from);
  const domain = email.split('@')[1] ?? '';
  const normalizedSubject = subject.toLowerCase();
  return patterns.some(pattern => pattern.kind === 'address' ? email === pattern.value
    : pattern.kind === 'domain' ? domain === pattern.value || domain.endsWith(`.${pattern.value}`)
      : normalizedSubject.startsWith(pattern.value));
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: '\u00a0' };
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);/gi, (entity, key: string) => {
    if (key[0] !== '#') return named[key.toLowerCase()] ?? entity;
    const hex = key[1]?.toLowerCase() === 'x';
    const point = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isInteger(point) || point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(point);
  });
}

// Sender classification is conservative and heuristic; headers cannot prove a person.
export function isPersonMessage(message: gmail_v1.Schema$Message): boolean {
  const from = header(message, 'From');
  const email = mailbox(from);
  if (!email) return false;
  if (message.payload?.headers?.some(h => h.name?.toLowerCase() === 'list-unsubscribe')) return false;
  if (header(message, 'Auto-Submitted') && header(message, 'Auto-Submitted').trim().toLowerCase() !== 'no') return false;
  if (/^(bulk|list|junk)$/i.test(header(message, 'Precedence').trim()) || header(message, 'List-Id')) return false;
  const [local, domain] = email.split('@');
  if (/(?:no[._-]?reply|do[._-]?not[._-]?reply|notifications?|mailer[._-]?daemon|postmaster|bounce|newsletter|automated|(?:^|[._+-])(?:alerts?|bot|receipts?)(?:$|[._+-]))/i.test(local)) return false;
  const services = /(?:^|[.\s_+@-])(github|slack|vercel|supabase|stripe)(?:$|[.\s_+@-])/i;
  return !services.test(domain) && !services.test(local) && !services.test(from.replace(/<[^<>]+>/, ''));
}

export function threadForDigest(
  thread: gmail_v1.Schema$Thread, account: string, owners: Set<string>, rules: Rule[], since: number, until: number,
  ignorePatterns: DigestIgnorePattern[] = [],
): DigestThread | undefined {
  const messages = (thread.messages ?? []).filter(m => !m.labelIds?.includes('DRAFT'));
  if (!messages.length) return;
  // Gmail's internalDate, rather than a sender-controlled Date header, defines activity.
  if (messages.some(m => !m.internalDate || !Number.isFinite(Number(m.internalDate)))) {
    throw new Error('Thread has no valid received time');
  }
  const latest = messages.reduce((a, b) => Number(a.internalDate) > Number(b.internalDate) ? a : b);
  const time = Number(latest.internalDate);
  const from = header(latest, 'From');
  const subject = decodeHtmlEntities(header(latest, 'Subject'));
  if (time <= since || time > until || owners.has(mailbox(from)) || !isPersonMessage(latest)
    || /\[Muse\]/i.test(subject) || rules.some(rule => matchesRule(rule, account, from, subject))
    || ignoredByLocalPatterns(from, subject, ignorePatterns)) return;
  if (!thread.id) throw new Error('Thread has no id');
  if (!latest.id) throw new Error('Thread has no message id');
  return { id: thread.id, messageId: latest.id, from: oneLine(from), subject: oneLine(subject) || '(no subject)', time,
    snippet: oneLine(decodeHtmlEntities(latest.snippet ?? '')).slice(0, 320) };
}

export function formatHonolulu(time: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Pacific/Honolulu', month: 'short', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(time).replace(/AM|PM/g, value => value.toLowerCase());
}

export function renderDigest(groups: DigestGroup[], now: number): DigestEmail {
  const count = groups.reduce((n, group) => n + group.threads.length, 0);
  const date = new Intl.DateTimeFormat('en-US', { timeZone: 'Pacific/Honolulu', month: 'short', day: '2-digit' }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Pacific/Honolulu', hour: 'numeric', hourCycle: 'h23' }).format(now));
  const period = hour < 11 ? 'AM' : hour < 14 ? 'Midday' : 'PM';
  const lines = [`${count} threads — ${groups.map(g => `${g.account.email}: ${g.threads.length}`).join('; ')}`, 'Times: Pacific/Honolulu', ''];
  for (const group of groups.filter(g => g.threads.length)) {
    lines.push(group.account.email, '');
    for (const thread of group.threads) {
      lines.push(`From: ${thread.from}`, `Subject: ${thread.subject}`, `Received: ${formatHonolulu(thread.time)}`,
        thread.snippet, `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(group.account.email)}#all/${encodeURIComponent(thread.id)}`, '');
    }
  }
  return { subject: `[Mail digest] ${date} ${period} — ${count} threads`, body: lines.join('\n'), count };
}

export async function collectDigest(options: {
  accounts: AccountConfig[]; config: DigestConfig; rules: Rule[]; since: number; now: number;
  ignorePatterns?: DigestIgnorePattern[];
  client: (account: AccountConfig) => Promise<ReadonlyDigestGmail>;
}): Promise<DigestGroup[]> {
  const { accounts, config, rules, since, now, client, ignorePatterns = [] } = options;
  const owners = new Set(accounts.map(a => address(a.email)));
  const clients = new Map<AccountConfig, ReadonlyDigestGmail>();
  // Include aliases from skipped accounts too: a reply from any owned identity closes a thread.
  for (const account of accounts) {
    const gmail = await client(account);
    clients.set(account, gmail);
    const { data } = await gmail.users.settings.sendAs.list({ userId: 'me' });
    for (const alias of data.sendAs ?? []) {
      if (alias.sendAsEmail) owners.add(address(alias.sendAsEmail));
    }
  }
  const groups: DigestGroup[] = [];
  for (const account of accounts) {
    if (config.skipAccounts.has(account.email.toLowerCase()) || config.skipAccounts.has(account.alias.toLowerCase())) continue;
    const gmail = clients.get(account)!;
    const ids = new Set<string>();
    let pageToken: string | undefined;
    do {
      const { data } = await gmail.users.threads.list({ userId: 'me',
        q: `after:${Math.floor((since - 1) / 1000)} before:${Math.floor(now / 1000) + 1}`,
        maxResults: 500, pageToken });
      for (const thread of data.threads ?? []) if (thread.id) ids.add(thread.id);
      pageToken = data.nextPageToken || undefined;
    } while (pageToken);
    const threads: DigestThread[] = [];
    for (const id of ids) {
      let data: gmail_v1.Schema$Thread;
      try {
        ({ data } = await gmail.users.threads.get({ userId: 'me', id, format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'List-Unsubscribe', 'List-Id', 'Precedence', 'Auto-Submitted'],
          fields: 'id,messages(id,internalDate,labelIds,snippet,payload/headers)' }));
      } catch (error) {
        const e = error as { code?: number; response?: { status?: number } };
        if ((e.response?.status ?? e.code) === 404) continue;
        throw error;
      }
      const thread = threadForDigest(data, account.alias, owners, rules, since, now, ignorePatterns);
      if (thread) threads.push(thread);
    }
    threads.sort((a, b) => b.time - a.time);
    groups.push({ account, threads });
  }
  return groups;
}

export async function sendDigest(
  config: DigestConfig, recipient: string, email: DigestEmail, client: () => Promise<DigestSendGmail>,
): Promise<void> {
  // Validate before even loading the sending client; there is no cc/bcc surface.
  if (address(recipient) !== address(config.to)) throw new Error('Digest recipient must equal DIGEST_TO');
  const from = address(config.from);
  if (!email.count) return;
  const body = Buffer.from(email.body).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  const raw = Buffer.from([
    `From: ${from}`, `To: ${address(config.to)}`,
    `Subject: =?UTF-8?B?${Buffer.from(email.subject).toString('base64')}?=`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body,
  ].join('\r\n')).toString('base64url');
  const gmail = await client();
  // No retries: an ambiguous send failure must not cause a second email in this run.
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

export async function loadDigestRules(path: string): Promise<Rule[]> {
  let value: string;
  try { value = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return parseRules(JSON.parse(value));
}

export async function runDigest(options: {
  config: DigestConfig; accounts: AccountConfig[]; rules: Rule[];
  ignorePatterns?: DigestIgnorePattern[]; ignoreFilePath?: string;
  client: (account: AccountConfig) => Promise<ReadonlyDigestGmail>;
  sendClient: (account: AccountConfig) => Promise<DigestSendGmail>;
  send?: boolean; stateDirectory?: string; now?: number; output?: (text: string) => void;
  selectionOut?: string; warn?: (message: string) => void;
}): Promise<DigestEmail> {
  const { config, accounts } = options;
  // Exact configured address only; do not use the resolver's partial matching.
  const sender = accounts.find(a => a.email.toLowerCase() === config.from);
  if (!sender) throw new Error('DIGEST_FROM must be a configured account email');
  const dir = options.stateDirectory ?? join(homedir(), '.local/state/mail-digest');
  const statePath = join(dir, 'state.json');
  const lockPath = join(dir, 'run.lock');
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  if (options.send) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    lock = await open(lockPath, 'wx', 0o600);
  }
  try {
    const now = options.now ?? Date.now();
    let since = now - 24 * 60 * 60 * 1000;
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      if (!Number.isSafeInteger(state.lastDigest) || state.lastDigest < 0 || state.lastDigest > now) throw new Error('Invalid digest state');
      since = state.lastDigest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const ignorePatterns = options.ignorePatterns ?? await loadDigestIgnorePatterns(options.ignoreFilePath);
    const groups = await collectDigest({ ...options, ignorePatterns, since, now });
    const email = renderDigest(groups, now);
    if (options.send) {
      await sendDigest(config, config.to, email, () => options.sendClient(sender));
      if (options.selectionOut) {
        try {
          await writeDigestSelection(options.selectionOut, digestSelection(groups, since, now));
        } catch {
          // The digest email already succeeded; a sidecar write must not fail the run.
          (options.warn ?? console.warn)('Warning: DIGEST_SELECTION_OUT could not be written; digest send continued');
        }
      }
      // Advance only after a successful send (or a successfully scanned empty window).
      await writeFile(`${statePath}.new`, JSON.stringify({ lastDigest: now }) + '\n', { mode: 0o600 });
      await rename(`${statePath}.new`, statePath);
    } else if (email.count) {
      (options.output ?? console.log)(`From: ${config.from}\nTo: ${config.to}\nSubject: ${email.subject}\n\n${email.body}`);
    }
    return email;
  } finally {
    if (lock) {
      await lock.close();
      await unlink(lockPath);
    }
  }
}

async function main() {
  const mode = parseDigestArgs(process.argv.slice(2));
  const config = parseDigestConfig(process.env);
  const { getAccounts } = await import('../config.js');
  const { getGmailClient } = await import('../gmail/client.js');
  const rules = await loadDigestRules(join(homedir(), '.config/gmail-alerts/rules.json'));
  await runDigest({
    config, accounts: getAccounts(), rules, client: getGmailClient, sendClient: getGmailClient, ...mode,
    selectionOut: digestSelectionOutPath(process.env),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Provider errors may include credentials; never print raw errors.
    console.error('Mail digest failed. Check DIGEST_TO/DIGEST_FROM/DIGEST_SKIP_ACCOUNTS, account configuration, stored authentication, alert rules, and state/lock permissions.');
    process.exitCode = 1;
  });
}
