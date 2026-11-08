#!/usr/bin/env node
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { gmail_v1 } from 'googleapis';
import { parseWebhookConfig } from './watcher.js';

const HOUR = 3_600_000;
const ACCOUNT = 'kevin@cyberwingman.ai';
const MUSE = 'kevin.m.desler@gmail.com';
export interface ReadonlyMuseGmail {
  users: {
    labels: { list(params: gmail_v1.Params$Resource$Users$Labels$List): Promise<{ data: gmail_v1.Schema$ListLabelsResponse }> };
    messages: {
      list(params: gmail_v1.Params$Resource$Users$Messages$List): Promise<{ data: gmail_v1.Schema$ListMessagesResponse }>;
      get(params: gmail_v1.Params$Resource$Users$Messages$Get): Promise<{ data: gmail_v1.Schema$Message }>;
    };
  };
}
interface Mail { id: string; subject: string; from: string; to: string[]; time: number; body: string; museLabel: boolean }
interface Entry { active: boolean; detail: string }
interface State { version: 1; checkedThrough: number; alerts: Record<string, Entry> }
export interface Notice { key: string; color: 'amber' | 'green'; text: string }
export type Poster = (notice: Notice) => Promise<void>;
export const defaultStatePath = () => join(homedir(), '.local/state/muse-watch/state.json');
const addresses = (value: string) => (value.toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/g) ?? []);

async function scan(gmail: ReadonlyMuseGmail): Promise<Mail[]> {
  const { data: labels } = await gmail.users.labels.list({ userId: 'me' });
  const museLabels = new Set((labels.labels ?? []).filter(l => /^\[?muse\]?$/i.test(l.name ?? '')).map(l => l.id));
  const ids = new Set<string>();
  // No age cutoff: old, unresolved orders and HOLDING acknowledgments must not
  // disappear merely because the cron was offline or an email aged out.
  let pageToken: string | undefined;
  do {
    const { data } = await gmail.users.messages.list({ userId: 'me', q: '{subject:Muse label:Muse label:"[Muse]"}', maxResults: 500, pageToken });
    for (const message of data.messages ?? []) if (message.id) ids.add(message.id);
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  const mails: Mail[] = [];
  for (const id of ids) {
    const { data } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    if (data.labelIds?.some(l => ['DRAFT', 'SPAM', 'TRASH'].includes(l))) continue;
    const header = (name: string) => data.payload?.headers?.find(h => h.name?.toLowerCase() === name)?.value ?? '';
    const time = Number(data.internalDate);
    if (!data.internalDate || !Number.isFinite(time)) throw new Error('Missing arrival timestamp');
    const plain: string[] = [];
    const visit = (part: gmail_v1.Schema$MessagePart) => {
      if (part.filename) return;
      if (part.mimeType === 'text/plain' && part.body?.data) plain.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
      for (const child of part.parts ?? []) visit(child);
    };
    if (data.payload) visit(data.payload);
    if (header('subject').startsWith('[Muse] Ack') && !plain.length) throw new Error('Ack body unavailable');
    mails.push({ id, subject: header('subject'), from: addresses(header('from'))[0] ?? '',
      to: addresses(header('to')), time, body: plain.join('\n'), museLabel: data.labelIds?.some(l => museLabels.has(l)) ?? false });
  }
  return mails;
}

export async function runMuseWatch(deps: {
  gmail: ReadonlyMuseGmail | (() => Promise<ReadonlyMuseGmail>); post: Poster; statePath?: string; now?: number;
  dryRun?: boolean; output?: (notice: Notice) => void;
}): Promise<Notice[]> {
  const now = deps.now ?? Date.now();
  const file = deps.statePath ?? defaultStatePath();
  let state: State;
  let firstEvaluation = false;
  try {
    state = JSON.parse(await readFile(file, 'utf8')) as State;
    if (state.version !== 1 || !Number.isFinite(state.checkedThrough) || !state.alerts || typeof state.alerts !== 'object'
      || Object.values(state.alerts).some(e => !e || typeof e.active !== 'boolean' || typeof e.detail !== 'string')) throw new Error('Invalid Muse watch state');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    firstEvaluation = true;
    state = { version: 1, checkedThrough: now - 24 * HOUR, alerts: {} };
  }
  const notices: Notice[] = [];
  async function transition(key: string, failing: boolean, detail: string) {
    const previous = state.alerts[key];
    // Resolved keys are retained forever: an old slot/order never re-alerts.
    if (failing ? previous !== undefined : !previous?.active) return;
    const color = failing ? 'amber' : 'green';
    const notice: Notice = { key, color, text: `${failing ? '🟡' : '🟢'} 🔮 INFLECTO · Muse ${failing ? detail : `recovered: ${previous!.detail}`} · ${key} → ${failing ? 'watch Muse mail' : 'no action'}` };
    notices.push(notice);
    deps.output?.(notice);
    if (!deps.dryRun) await deps.post(notice);
    state.alerts[key] = { active: failing, detail };
    // Persist each successful transition, even if a later post fails.
    if (!deps.dryRun) await save();
  }
  async function save() {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(`${file}.new`, JSON.stringify(state) + '\n', { mode: 0o600 });
    await rename(`${file}.new`, file);
  }
  let mails: Mail[];
  try { mails = await scan(typeof deps.gmail === 'function' ? await deps.gmail() : deps.gmail); }
  catch {
    await transition('source', true, 'Gmail source unknown');
    return notices;
  }
  // Unknown can recur after recovery; slot/order/ack identities cannot.
  if (state.alerts.source?.active) await transition('source', false, 'Gmail source unknown');
  delete state.alerts.source;
  const incoming = mails.filter(m => m.to.includes(ACCOUNT) && m.from !== ACCOUNT && m.time <= now);
  const reports = incoming.filter(m => /^(?:Muse Inflecto test|\[Muse\] Spec)/.test(m.subject));
  const acks = incoming.filter(m => m.subject.startsWith('[Muse] Ack: '));
  const start = Math.floor(state.checkedThrough / (24 * HOUR)) * 24 * HOUR;
  for (let day = start; day <= now; day += 24 * HOUR) {
    for (const hour of [0, 3, 18, 21]) {
      const slot = day + hour * HOUR;
      if (slot + 2 * HOUR <= state.checkedThrough || slot + 2 * HOUR > now) continue;
      const key = `slot:${new Date(slot).toISOString()}`;
      const report = reports.find(m => m.time >= slot && m.time <= slot + 2 * HOUR);
      if (!report && !(firstEvaluation && slot + 2 * HOUR < now)) await transition(key, true, `REPORT MISSING after ${new Date(slot).toISOString()}`);
    }
  }
  if (!firstEvaluation) {
    for (const [key, entry] of Object.entries(state.alerts)) {
      if (key.startsWith('slot:') && entry.active && reports.some(m => m.time >= Date.parse(key.slice(5)))) {
        await transition(key, false, entry.detail);
      }
    }
  }
  const orders = mails.filter(m => [ACCOUNT, MUSE].includes(m.from) && m.to.includes(MUSE)
    && (m.subject.startsWith('[Muse]') || m.museLabel)
    && !/^(?:Muse Inflecto test|\[Muse\] (?:Spec|Ack))/.test(m.subject) && m.time <= now);
  for (const order of orders) {
    // Repeated subjects require distinct acknowledgments following each order.
    const next = orders.filter(m => m.subject === order.subject && m.time > order.time).sort((a, b) => a.time - b.time)[0];
    const ack = acks.find(m => m.subject === `[Muse] Ack: ${order.subject}` && m.time >= order.time && (!next || m.time < next.time));
    const key = `order:${order.id}`;
    if (!(firstEvaluation && order.time + 24 * HOUR <= now) && now >= order.time + HOUR / 4 && (!ack || ack.time > order.time + HOUR / 4)) {
      await transition(key, true, `ORDER UNACKED ${order.subject}`);
    }
    if (ack) await transition(key, false, order.subject);
  }
  for (const ack of acks) {
    if (!/Status:\s*HOLDING\b/i.test(ack.body)) continue;
    const key = `holding:${ack.id}`;
    const holding = ack.body.match(/Status:\s*HOLDING\b([\s\S]*)/i)?.[1] ?? '';
    const reason = holding.replace(/^\s*Reason:\s*/i, '').trim().slice(0, 200) || 'reason not provided';
    const resolved = acks.some(m => m.subject === ack.subject && m.time > ack.time
      && /^\s*Status:\s*(?!HOLDING\b)\S+/im.test(m.body));
    if (resolved) await transition(key, false, ack.subject);
    else await transition(key, true, `ACK HOLDING ${ack.subject}: ${reason}`);
  }
  state.checkedThrough = now;
  if (!deps.dryRun) await save();
  return notices;
}

export function webhookPoster(config: Record<string, string>, log = console.warn): Poster {
  return async notice => {
    const key = notice.color === 'amber' ? 'SLACK_ALERTS_WATCH_WEBHOOK_URL' : 'SLACK_ALERTS_OK_WEBHOOK_URL';
    const url = config[key];
    if (!url) {
      log(`Muse watch: ${key} unavailable; dropping ${notice.color} alert`);
      return;
    }
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: notice.text }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Slack post failed');
  };
}

export function parseArgs(args: string[]): boolean {
  if (args.some(arg => arg !== '--dry-run')) throw new Error('Usage: muse-watch [--dry-run]');
  return args.includes('--dry-run');
}
async function main() {
  const dryRun = parseArgs(process.argv.slice(2));
  const file = defaultStatePath();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lockPath = join(dirname(file), 'run.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    const { getGmailClient } = await import('../gmail/client.js');
    await runMuseWatch({ gmail: () => getGmailClient(ACCOUNT), dryRun,
      // Load configuration lazily so previews need no Slack credentials.
      post: async notice => webhookPoster(parseWebhookConfig(await readFile(join(homedir(), '.config/desler/alerts.env'), 'utf8')))(notice),
      output: notice => console.log(JSON.stringify(notice)) });
  } finally { await lock.close(); await unlink(lockPath); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Muse watch failed. Check arguments, Gmail access, Slack configuration, and state lock.'); process.exitCode = 1; });
}
