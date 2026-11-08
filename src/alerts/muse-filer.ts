#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { gmail_v1 } from 'googleapis';

const fields = ['TITLE', 'REPRO', 'EXPECTED', 'ACTUAL', 'EVIDENCE', 'SEVERITY'] as const;
type Field = typeof fields[number];
export type Finding = Partial<Record<Field, string>>;
export const routes: Record<string, string> = {
  inflecto: 'kmdesle/inflecto-ai', sendinel: 'kmdesle/sendinel-ai', synchronex: 'kmdesle/synchronex',
  tractic: 'tractic-io/tractic-2.0', 'cyber-wingman': 'kmdesle/cyber-wingman', cw: 'kmdesle/cyber-wingman',
  hashfolio: 'kmdesle/hashfolio', wfi: 'kmdesle/wfi-hyperion', hyperion: 'kmdesle/wfi-hyperion',
  wren: 'kmdesle/wren-app', 'act-now': 'kmdesle/act-now',
};

// A line grammar only. Email text never becomes code, commands, or instructions.
export function parseEmail(body: string): { findings: Finding[]; regressions: string[]; nothingFound: boolean } {
  const findings: Finding[] = [];
  const regressions: string[] = [];
  let current: Finding | undefined;
  let field: Field | undefined;
  let regressionSection = false;
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(?:#{1,6}\s*)?(?:\*\*)?regression(?:s| verdicts?| results?)?\s*:?\s*(?:\*\*)?\s*$/i.test(line)) {
      regressionSection = true;
      field = undefined;
      continue;
    }
    const match = line.match(/^\s*(TITLE|REPRO|EXPECTED|ACTUAL|EVIDENCE|SEVERITY):\s*(.*)$/);
    if (match) {
      const name = match[1] as Field;
      if (name === 'TITLE' || regressionSection || (current && current[name] !== undefined)) current = undefined;
      regressionSection = false;
      if (!current) { current = {}; findings.push(current); }
      current[name] = match[2];
      field = name;
    } else if ((regressionSection || /\b(?:regression|pass|fail|fixed|still broken)\b/i.test(line)) && /#\d+\b/.test(line)) {
      regressions.push(line.trim());
      field = undefined;
    } else if (current && field) {
      current[field] += '\n' + line;
    }
  }
  for (const finding of findings) for (const key of fields) if (finding[key] !== undefined) finding[key] = finding[key]!.trim();
  return { findings, regressions, nothingFound: !findings.length && /\bnothing found\b/i.test(body) };
}

export function routeTitle(title: string): { repo: string; title: string } | undefined {
  const match = title.match(/^\s*(Inflecto|Sendinel|Synchronex|Tractic|Cyber-Wingman|CW|Hashfolio|WFI|Hyperion|Wren|ACT-Now)(?:\s*(?::|[-–—])\s*|\s+)(\S[^\n]*)$/i);
  if (!match) return undefined;
  return { repo: routes[match[1].toLowerCase()], title: `[muse] ${match[2].trim()}` };
}

export function normalizeTitle(title: string): string[] {
  return [...new Set(title.toLowerCase().replace(/^\s*\[muse\]\s*/, '').replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean))];
}
export function jaccard(a: string, b: string): number {
  const left = new Set(normalizeTitle(a));
  const right = new Set(normalizeTitle(b));
  const union = new Set([...left, ...right]);
  return union.size ? [...left].filter(token => right.has(token)).length / union.size : 0;
}
export interface Issue { number: number; title: string; body?: string; url?: string }
export function findDuplicate(title: string, messageId: string, issues: Issue[]): Issue | undefined {
  return issues.find(issue => jaccard(title, issue.title) >= 0.7
    || (normalizeTitle(title).sort().join(' ') === normalizeTitle(issue.title).sort().join(' ')
      && issue.body?.split('\n').includes(`Filed from Muse email ${messageId}`)));
}
export function issueBody(finding: Finding, messageId: string): string {
  return fields.filter(key => key !== 'TITLE').map(key => `## ${key}\n\n${finding[key] || '(not provided)'}`).join('\n\n')
    + `\n\nFiled from Muse email ${messageId}`;
}

export type Gh = (args: string[]) => Promise<string>;
export interface Mail { id: string; subject: string; body: string }
export interface GmailClient {
  messages(): AsyncIterable<Mail>;
  markFiled(id: string): Promise<void>;
}
export interface Result {
  message_id: string; title: string;
  action: 'filed' | 'duplicate' | 'malformed' | 'unrouted';
  issue?: string | number; reason?: string;
}
export interface Run {
  ts: string; dry_run: boolean; results: Result[];
  regressions: { message_id: string; verdict: string }[];
  skipped: { message_id: string; reason: string }[];
  planned: { message_id: string; title: string; repo: string; body: string; labels: string[] }[];
  error?: string;
}
interface RepoState { issues: Issue[]; recovery: Issue[]; labels: string[] }

export async function runFiler(deps: {
  gmail: GmailClient; gh: Gh; apply?: boolean;
  output?: (value: unknown) => void;
  record: (run: Run) => Promise<void>;
}): Promise<Run> {
  const run: Run = { ts: new Date().toISOString(), dry_run: !deps.apply, results: [], regressions: [], skipped: [], planned: [] };
  const output = deps.output ?? console.log;
  const repos = new Map<string, RepoState>();
  let filed = 0;
  const gh = deps.gh;
  async function repoState(repo: string): Promise<RepoState> {
    let state = repos.get(repo);
    if (!state) {
      const verified = JSON.parse(await gh(['repo', 'view', repo, '--json', 'nameWithOwner']));
      if (verified.nameWithOwner.toLowerCase() !== repo.toLowerCase()) throw new Error(`Repository route changed: ${repo}`);
      const labels: { name: string }[] = JSON.parse(await gh(['label', 'list', '--repo', repo, '--limit', '1000', '--json', 'name']));
      const issues: Issue[] = JSON.parse(await gh(['issue', 'list', '--repo', repo, '--label', 'muse-test', '--state', 'open', '--limit', '200', '--json', 'number,title,body,url']));
      // REST pagination avoids search-index lag for footer recovery, including
      // closed/unlabeled issues after an ambiguous create or Gmail-label failure.
      const pages: Issue[][] = JSON.parse(await gh(['api', '--method', 'GET', `repos/${repo}/issues?state=all&per_page=100`, '--paginate', '--slurp']));
      state = { labels: labels.map(label => label.name), issues, recovery: pages.flat() };
      repos.set(repo, state);
    }
    return state;
  }
  function report(result: Result) { run.results.push(result); output(result); }
  try {
    for await (const mail of deps.gmail.messages()) {
      if (!mail.subject.startsWith('[Muse] Spec')) continue;
      const parsed = parseEmail(mail.body);
      for (const verdict of parsed.regressions) {
        const item = { message_id: mail.id, verdict };
        run.regressions.push(item); output({ regression: item });
      }
      let complete = true;
      if (!parsed.findings.length) {
        const reason = parsed.nothingFound ? 'nothing found' : parsed.regressions.length ? 'regressions only' : 'No finding blocks or nothing-found declaration';
        run.skipped.push({ message_id: mail.id, reason }); output({ message_id: mail.id, reason });
        if (!parsed.nothingFound && !parsed.regressions.length) report({ message_id: mail.id, title: '', action: 'malformed', reason });
      }
      for (const finding of parsed.findings) {
        const base = { message_id: mail.id, title: finding.TITLE ?? '' };
        const missing = ['TITLE', 'REPRO', 'ACTUAL'].filter(key => !finding[key as Field]);
        if (missing.length || finding.TITLE?.includes('\n')) {
          report({ ...base, action: 'malformed', reason: missing.length ? `Missing ${missing.join(', ')}` : 'TITLE must be one line' }); continue;
        }
        const route = routeTitle(finding.TITLE!);
        if (!route) { report({ ...base, action: 'unrouted' }); complete = false; continue; }
        const state = await repoState(route.repo);
        const exactRecovery = state.recovery.filter(issue => issue.body?.split('\n').includes(`Filed from Muse email ${mail.id}`));
        const duplicate = findDuplicate(route.title, mail.id, state.issues)
          ?? exactRecovery.find(issue => normalizeTitle(route.title).sort().join(' ') === normalizeTitle(issue.title).sort().join(' '));
        if (duplicate) { report({ ...base, action: 'duplicate', ...(duplicate.number ? { issue: duplicate.number } : { reason: 'Duplicates a finding already planned in this dry run' }) }); continue; }
        if (filed >= 10) { complete = false; run.skipped.push({ message_id: mail.id, reason: '10-issue cap reached' }); output({ ...base, deferred: '10-issue cap reached' }); continue; }
        const labels = ['muse-test', 'needs-spec'];
        // Only use an unambiguous, already-existing highest-priority label.
        const priorities = state.labels.filter(label => /^(?:p[01]|priority:\s*(?:critical|high|highest|p[01])|priority[- ](?:critical|high))$/i.test(label));
        if (finding.SEVERITY?.toLowerCase() === 'wrong number' && priorities.length === 1) labels.push(priorities[0]);
        const body = issueBody(finding, mail.id);
        output({ would_file: { repo: route.repo, title: route.title, body, labels }, missing_labels: labels.filter(label => !state.labels.includes(label)) });
        if (!deps.apply) {
          run.planned.push({ message_id: mail.id, title: route.title, repo: route.repo, body, labels });
          filed++;
          state.issues.push({ number: 0, title: route.title, body });
          continue;
        }
        if (!state.labels.includes('needs-spec')) throw new Error(`Missing existing needs-spec label in ${route.repo}`);
        if (!state.labels.includes('muse-test')) {
          await gh(['label', 'create', 'muse-test', '--repo', route.repo, '--color', '7057ff', '--description', 'Findings from Muse structured test emails']);
          state.labels.push('muse-test');
        }
        const url = (await gh(['issue', 'create', '--repo', route.repo, '--title', route.title, '--body', body, ...labels.flatMap(label => ['--label', label])])).trim();
        filed++;
        const number = Number(url.match(/\/issues\/(\d+)$/)?.[1]);
        state.issues.push({ number, title: route.title, body, url });
        report({ ...base, action: 'filed', issue: url });
      }
      if (complete && deps.apply) await deps.gmail.markFiled(mail.id);
    }
    return run;
  } catch (error) {
    // Provider errors can contain credentials. Keep diagnostics local and bounded.
    run.error = 'Run failed; uncompleted emails remain pending. Check account access, repository access, and needs-spec labels.';
    output({ error: run.error });
    throw new Error(run.error);
  } finally {
    await deps.record(run);
  }
}

export function gmailAdapter(gmail: Pick<gmail_v1.Gmail, 'users'>): GmailClient {
  let filedLabel: string | undefined;
  return {
    async *messages() {
      const { data } = await gmail.users.labels.list({ userId: 'me' });
      filedLabel = data.labels?.find(label => label.name === 'muse-filed')?.id ?? undefined;
      // Snapshot ids before modifying labels so pagination cannot skip messages.
      const ids = new Set<string>();
      let pageToken: string | undefined;
      do {
        const { data: page } = await gmail.users.messages.list({ userId: 'me', q: 'subject:"[Muse] Spec" -label:muse-filed', maxResults: 100, pageToken });
        for (const message of page.messages ?? []) if (message.id) ids.add(message.id);
        pageToken = page.nextPageToken ?? undefined;
      } while (pageToken);
      for (const id of ids) {
        const { data: message } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        if (filedLabel && message.labelIds?.includes(filedLabel)) continue;
        const subject = message.payload?.headers?.find(header => header.name?.toLowerCase() === 'subject')?.value ?? '';
        if (!subject.startsWith('[Muse] Spec')) continue;
        const plain: string[] = [];
        const visit = (part: gmail_v1.Schema$MessagePart) => {
          if (part.filename) return;
          if (part.mimeType === 'text/plain' && part.body?.data) plain.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
          for (const child of part.parts ?? []) visit(child);
        };
        if (message.payload) visit(message.payload);
        if (!plain.length) throw new Error('Muse email requires an inline text/plain body');
        yield { id, subject, body: plain.join('\n') };
      }
    },
    async markFiled(id) {
      if (!filedLabel) {
        const { data } = await gmail.users.labels.create({ userId: 'me', requestBody: { name: 'muse-filed' } });
        if (!data.id) throw new Error('Gmail did not return a label id');
        filedLabel = data.id;
      }
      await gmail.users.messages.modify({ userId: 'me', id, requestBody: { addLabelIds: [filedLabel] } });
    },
  };
}

export function parseArgs(args: string[]): boolean {
  if (args.some(arg => arg !== '--apply' && arg !== '--dry-run') || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Usage: muse-filer [--dry-run | --apply]');
  }
  return args.includes('--apply');
}

async function main() {
  const apply = parseArgs(process.argv.slice(2));
  const directory = join(homedir(), '.local/state/muse-filer');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Serialize local runs, including recovery checks and creation. A stale lock
  // after SIGKILL must be removed by the operator after checking no run is active.
  const lockPath = join(directory, 'run.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    const { getGmailClient } = await import('../gmail/client.js');
    const exec = promisify(execFile);
    await runFiler({
      gmail: gmailAdapter(await getGmailClient('kevin.m.desler@gmail.com')), apply,
      gh: async args => (await exec('gh', args, { maxBuffer: 16 * 1024 * 1024 })).stdout,
      output: value => console.log(JSON.stringify(value)),
      record: async run => { await appendFile(join(directory, 'runs.jsonl'), JSON.stringify(run) + '\n', { mode: 0o600 }); },
    });
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Muse filer failed. Check arguments, credentials, state lock, access, and run log.'); process.exitCode = 1; });
}
