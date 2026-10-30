import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { gmail_v1 } from 'googleapis';

export interface Rule {
  account: string;
  from: string[];
  subject_contains?: string[];
  tag: string;
}

export interface Alert {
  ts: string;
  account: string;
  tag: string;
  from: string;
  subject: string;
  message_id: string;
  thread_id: string;
}

// Limit the watcher API surface to the three read operations it needs.
export interface ReadonlyGmail {
  users: {
    history: { list(params: gmail_v1.Params$Resource$Users$History$List): Promise<{ data: gmail_v1.Schema$ListHistoryResponse }> };
    messages: { get(params: gmail_v1.Params$Resource$Users$Messages$Get): Promise<{ data: gmail_v1.Schema$Message }> };
    getProfile(params: gmail_v1.Params$Resource$Users$Getprofile): Promise<{ data: gmail_v1.Schema$Profile }>;
  };
}

export function parseRules(value: unknown): Rule[] {
  if (!Array.isArray(value) || !value.length) throw new Error('rules.json must be a nonempty array');
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string' && s.trim());
  for (const rule of value) {
    if (!rule || typeof rule.account !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(rule.account)
      || !strings(rule.from) || typeof rule.tag !== 'string' || !rule.tag.trim()
      || (rule.subject_contains !== undefined && !strings(rule.subject_contains))) {
      throw new Error('Invalid alert rule: expected account alias, from[], optional subject_contains[], and tag');
    }
  }
  return value;
}

export function matchesRule(rule: Rule, account: string, from: string, subject: string): boolean {
  const mailbox = (from.match(/<([^<>]+)>\s*$/)?.[1] ?? from).trim().toLowerCase();
  return rule.account === account
    && rule.from.some(sender => sender.trim().toLowerCase() === mailbox)
    && (rule.subject_contains === undefined
      || rule.subject_contains.some(text => subject.toLowerCase().includes(text.toLowerCase())));
}

function status(error: unknown): number {
  const e = error as { code?: number | string; response?: { status?: number } };
  return Number(e?.response?.status ?? e?.code);
}

function invalidGrant(error: unknown): boolean {
  const e = error as { message?: string; response?: { data?: { error?: string } } };
  return e?.response?.data?.error === 'invalid_grant' || /invalid_grant/i.test(e?.message ?? '');
}

export class AccountWatcher {
  private failures = 0;
  private errorReported = false;
  private busy = false;
  private heartbeatDay = '';

  constructor(
    readonly account: string,
    private rules: Rule[],
    private stateDirectory: string,
    private client: () => Promise<ReadonlyGmail>,
    private log: (line: string) => void = console.log,
    private now: () => Date = () => new Date(),
  ) {
    if (!/^[a-zA-Z0-9_-]+$/.test(account)) throw new Error('Unsafe account alias');
  }

  private logEvent(event: string, extra = {}) {
    this.log(JSON.stringify({ ts: this.now().toISOString(), account: this.account, event, ...extra }));
  }

  private async save(historyId: string) {
    const file = join(this.stateDirectory, `${this.account}.json`);
    await writeFile(`${file}.new`, JSON.stringify({ historyId }) + '\n', { mode: 0o600 });
    await rename(`${file}.new`, file);
  }

  private async emit(alert: Alert) {
    await appendFile(join(this.stateDirectory, 'alerts.jsonl'), JSON.stringify(alert) + '\n', { mode: 0o600 });
  }

  private async seed(gmail: ReadonlyGmail, gap: boolean) {
    const { data } = await gmail.users.getProfile({ userId: 'me' });
    if (!data.historyId) throw new Error('Profile has no historyId');
    // Log before advancing: a gap must never be silently skipped.
    this.logEvent(gap ? 'gap' : 'seed', { historyId: data.historyId });
    await this.save(data.historyId);
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
      const day = this.now().toISOString().slice(0, 10);
      if (day !== this.heartbeatDay) {
        this.logEvent('heartbeat');
        this.heartbeatDay = day;
      }
      await this.pollHistory();
      this.failures = 0;
      this.errorReported = false;
    } catch (error) {
      this.failures++;
      const revoked = invalidGrant(error);
      // Avoid raw provider errors: they can contain request headers or credentials.
      this.logEvent('poll_failure', { consecutive: this.failures, invalid_grant: revoked });
      if (!this.errorReported && (revoked || this.failures >= 5)) {
        await this.emit({
          ts: this.now().toISOString(), account: this.account, tag: 'ERROR', from: '',
          subject: revoked ? 'Gmail authentication failed: invalid_grant' : 'Gmail poll failed 5 consecutive times',
          message_id: '', thread_id: '',
        });
        this.errorReported = true;
      }
    } finally {
      this.busy = false;
    }
  }

  private async pollHistory() {
    const gmail = await this.client();
    let historyId: string;
    try {
      const state = JSON.parse(await readFile(join(this.stateDirectory, `${this.account}.json`), 'utf8'));
      if (typeof state.historyId !== 'string' || !/^\d+$/.test(state.historyId)) throw new Error('Invalid history state');
      historyId = state.historyId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.seed(gmail, false);
      return;
    }

    const ids = new Set<string>();
    let pageToken: string | undefined;
    let nextHistoryId: string | undefined;
    do {
      let data: gmail_v1.Schema$ListHistoryResponse;
      try {
        ({ data } = await gmail.users.history.list({
          userId: 'me', startHistoryId: historyId, historyTypes: ['messageAdded'], labelId: 'INBOX', pageToken,
        }));
      } catch (error) {
        if (status(error) !== 404) throw error;
        await this.seed(gmail, true);
        return;
      }
      for (const record of data.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          if (added.message?.id) ids.add(added.message.id);
        }
      }
      nextHistoryId = data.historyId ?? nextHistoryId;
      pageToken = data.nextPageToken || undefined;
    } while (pageToken);
    if (!nextHistoryId) throw new Error('History response has no historyId');

    for (const id of ids) {
      let data: gmail_v1.Schema$Message;
      try {
        ({ data } = await gmail.users.messages.get({
          userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'],
          fields: 'id,threadId,payload/headers',
        }));
      } catch (error) {
        // A message can be permanently deleted between history and metadata reads.
        if (status(error) === 404) continue;
        throw error;
      }
      const headers = data.payload?.headers ?? [];
      const header = (name: string) => headers.find(h => h.name?.toLowerCase() === name)?.value ?? '';
      const from = header('from');
      const subject = header('subject');
      for (const rule of this.rules) {
        if (matchesRule(rule, this.account, from, subject)) {
          await this.emit({ ts: this.now().toISOString(), account: this.account, tag: rule.tag,
            from, subject, message_id: id, thread_id: data.threadId ?? '' });
        }
      }
    }
    await this.save(nextHistoryId);
  }
}
