import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Read-only by construction: the client interface exposes only two read methods.
export interface SlackChannel { id: string; name: string }
export interface SlackMessage {
  ts: string; text?: string; user?: string; username?: string; subtype?: string;
  bot_profile?: { name?: string }; thread_ts?: string;
}
export interface SlackPage<T> { items: T[]; nextCursor?: string }
export interface ReadonlySlack {
  memberChannels(cursor?: string): Promise<SlackPage<SlackChannel>>;
  history(channel: string, oldest: string, cursor?: string): Promise<SlackPage<SlackMessage>>;
}

export class SlackApiError extends Error {
  constructor(readonly code: string, readonly retryAfterSeconds?: number) {
    super(code);
  }
}

export interface Overrides { exclude: string[]; tags: Record<string, string> }
export type Color = 'red' | 'amber' | 'green' | null;
export interface SlackAlert {
  ts_iso: string; channel: string; tag: string; color: Color; ts: string; text: string;
  bot_name?: string; user?: string; thread_ts?: string;
}

const DISCOVERY_MS = 15 * 60_000;
const ERROR_THROTTLE_MS = 60 * 60_000;
const API = 'https://slack.com/api';

export function parseOverrides(value: unknown): Overrides {
  const v = (value ?? {}) as { exclude?: unknown; tags?: unknown };
  const exclude = v.exclude ?? [];
  const tags = v.tags ?? {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !Array.isArray(exclude) || !exclude.every(n => typeof n === 'string')
    || typeof tags !== 'object' || tags === null || Array.isArray(tags)
    || !Object.values(tags).every(t => typeof t === 'string' && t.trim())) {
    throw new Error('channels.json must be {"exclude"?: string[], "tags"?: {name: tag}}');
  }
  return { exclude: exclude as string[], tags: tags as Record<string, string> };
}

export function parseColor(text: string): Color {
  const first = text.trimStart().slice(0, 2);
  if (first.startsWith('🔴')) return 'red';
  if (first.startsWith('🟡')) return 'amber';
  if (first.startsWith('🟢')) return 'green';
  return null;
}

/** Plain-fetch Slack client. The token only ever goes in the Authorization header. */
export function createSlackClient(token: string, fetchImpl: typeof fetch = fetch): ReadonlySlack {
  async function call(method: string, params: Record<string, string>): Promise<any> {
    let response: Response;
    try {
      response = await fetchImpl(`${API}/${method}?${new URLSearchParams(params)}`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new SlackApiError('network_error');
    }
    if (response.status === 429) {
      const wait = Number(response.headers.get('retry-after'));
      throw new SlackApiError('ratelimited', Number.isFinite(wait) && wait > 0 ? wait : 30);
    }
    if (!response.ok) throw new SlackApiError(`http_${response.status}`);
    let body: { ok?: boolean; error?: string; response_metadata?: { next_cursor?: string } };
    try { body = await response.json(); } catch { throw new SlackApiError('invalid_response'); }
    if (!body.ok) throw new SlackApiError(String(body.error ?? 'unknown_error').slice(0, 64));
    return body;
  }
  return {
    async memberChannels(cursor) {
      const body = await call('users.conversations', {
        types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200', ...(cursor ? { cursor } : {}),
      });
      return { items: body.channels ?? [], nextCursor: body.response_metadata?.next_cursor || undefined };
    },
    async history(channel, oldest, cursor) {
      const body = await call('conversations.history', {
        channel, oldest, limit: '200', ...(cursor ? { cursor } : {}),
      });
      return { items: body.messages ?? [], nextCursor: body.response_metadata?.next_cursor || undefined };
    },
  };
}

function compareTs(a: string, b: string): number {
  return Number(a) - Number(b);
}

export function toAlert(msg: SlackMessage, channel: string, tag: string, now: Date): SlackAlert {
  const text = msg.text ?? '';
  const alert: SlackAlert = {
    ts_iso: now.toISOString(), channel, tag, color: parseColor(text), ts: msg.ts,
    text: Array.from(text).slice(0, 500).join(''),
  };
  const botName = msg.username ?? msg.bot_profile?.name;
  if (botName) alert.bot_name = botName;
  else if (msg.user) alert.user = msg.user;
  if (msg.thread_ts) alert.thread_ts = msg.thread_ts;
  return alert;
}

export class SlackWatcher {
  private channels: SlackChannel[] = [];
  private lastDiscovery = -Infinity;
  private pausedUntil = 0;
  private busy = false;
  private errorSeen = new Map<string, number>();
  private cursors: Record<string, string> | undefined;

  constructor(
    private client: ReadonlySlack,
    private stateDirectory: string,
    private overrides: Overrides = { exclude: [], tags: {} },
    private log: (line: string) => void = console.log,
    private now: () => Date = () => new Date(),
    private sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
  ) {}

  private nowTs(): string {
    return (this.now().getTime() / 1000).toFixed(6);
  }

  private logEvent(event: string, extra = {}) {
    this.log(JSON.stringify({ ts: this.now().toISOString(), event, ...extra }));
  }

  private tagFor(name: string): string {
    return this.overrides.tags[name] ?? name;
  }

  private async paginate<T>(fetchPage: (cursor?: string) => Promise<SlackPage<T>>): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await fetchPage(cursor);
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  }

  private async append(file: string, line: unknown) {
    await appendFile(join(this.stateDirectory, file), JSON.stringify(line) + '\n', { mode: 0o600 });
  }

  private async loadCursors(): Promise<Record<string, string>> {
    if (this.cursors) return this.cursors;
    try {
      const state = JSON.parse(await readFile(join(this.stateDirectory, 'state.json'), 'utf8'));
      if (!state || typeof state.channels !== 'object' || state.channels === null) throw new Error('Invalid state');
      this.cursors = state.channels;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.cursors = {};
    }
    return this.cursors!;
  }

  private async saveCursors() {
    const file = join(this.stateDirectory, 'state.json');
    await writeFile(`${file}.new`, JSON.stringify({ channels: this.cursors }) + '\n', { mode: 0o600 });
    await rename(`${file}.new`, file);
  }

  /** Append an ERROR line at most once per distinct (code, channel) per hour. */
  private async reportError(code: string, channel: string) {
    const key = `${code}\u0000${channel}`;
    const nowMs = this.now().getTime();
    const previous = this.errorSeen.get(key);
    this.logEvent('poll_failure', { code, channel });
    if (previous !== undefined && nowMs - previous < ERROR_THROTTLE_MS) return;
    this.errorSeen.set(key, nowMs);
    await this.append('alerts.jsonl', { ERROR: code, channel, ts_iso: this.now().toISOString() });
  }

  /** Member channels minus excluded ones. */
  async discover(): Promise<SlackChannel[]> {
    const found = await this.paginate(c => this.client.memberChannels(c));
    return found.filter(c => !this.overrides.exclude.includes(c.name));
  }

  private async refreshChannels() {
    if (this.now().getTime() - this.lastDiscovery < DISCOVERY_MS) return;
    try {
      this.channels = await this.discover();
      this.lastDiscovery = this.now().getTime();
      this.logEvent('discovered', { channels: this.channels.length });
    } catch (error) {
      if (!(error instanceof SlackApiError)) throw error;
      if (error.retryAfterSeconds) this.pausedUntil = this.now().getTime() + error.retryAfterSeconds * 1000;
      else await this.reportError(error.code, 'discovery');
    }
  }

  async poll(): Promise<void> {
    if (this.busy || this.now().getTime() < this.pausedUntil) return;
    this.busy = true;
    try {
      await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
      const cursors = await this.loadCursors();
      await this.refreshChannels();
      let dirty = false;
      for (const channel of this.channels) {
        if (cursors[channel.id] === undefined) {
          // First sight of a channel (first run or newly joined): start at now, no flood.
          cursors[channel.id] = this.nowTs();
          dirty = true;
          continue;
        }
        try {
          const messages = await this.paginate(c => this.client.history(channel.id, cursors[channel.id], c));
          messages.sort((a, b) => compareTs(a.ts, b.ts));
          const tag = this.tagFor(channel.name);
          for (const message of messages) {
            if (compareTs(message.ts, cursors[channel.id]) <= 0) continue;
            await this.append('alerts.jsonl', toAlert(message, channel.name, tag, this.now()));
            cursors[channel.id] = message.ts;
            dirty = true;
            await this.saveCursors();
          }
        } catch (error) {
          if (!(error instanceof SlackApiError)) throw error;
          if (error.retryAfterSeconds) {
            this.pausedUntil = this.now().getTime() + error.retryAfterSeconds * 1000;
            this.logEvent('rate_limited', { retry_after: error.retryAfterSeconds });
            break;
          }
          await this.reportError(error.code, channel.name);
        }
      }
      if (dirty) await this.saveCursors();
    } finally {
      this.busy = false;
    }
  }

  /** One-shot export of every member channel for the last `days` days. Returns the file path. */
  async backfill(days: number): Promise<string> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const file = `backfill-${this.now().toISOString().slice(0, 10)}.jsonl`;
    await writeFile(join(this.stateDirectory, file), '', { mode: 0o600 });
    const oldest = ((this.now().getTime() - days * 86_400_000) / 1000).toFixed(6);
    const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try { return await fn(); } catch (error) {
          if (!(error instanceof SlackApiError) || !error.retryAfterSeconds || attempt >= 5) throw error;
          await this.sleep(error.retryAfterSeconds * 1000);
        }
      }
    };
    const channels = await withRetry(() => this.discover());
    for (const channel of channels) {
      const messages = await this.paginate(c => withRetry(() => this.client.history(channel.id, oldest, c)));
      messages.sort((a, b) => compareTs(a.ts, b.ts));
      const tag = this.tagFor(channel.name);
      for (const message of messages) await this.append(file, toAlert(message, channel.name, tag, this.now()));
    }
    return file;
  }
}
