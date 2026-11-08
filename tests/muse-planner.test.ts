import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCoverageSection,
  normalizeBrief,
  computeScoreboard,
  runPlanner,
  parseArgs,
  type Matrix,
  type MatrixCell,
  type GitHubIssue,
  type Gh,
  type ReadonlyPlannerGmail,
  type MuseMail,
} from '../src/alerts/muse-planner.js';

function makeCell(id: string, overrides: Partial<MatrixCell> = {}): MatrixCell {
  return {
    id,
    kind: overrides.kind ?? 'valid',
    target: overrides.target ?? 'target',
    tier: overrides.tier ?? 'pro',
    surface: overrides.surface ?? 'mcp',
    steps: overrides.steps ?? [`Step 1 for ${id}`],
    pass: overrides.pass ?? `Pass condition for ${id}`,
    est_mcp_calls: overrides.est_mcp_calls ?? (overrides.surface === 'browser' ? 0 : 1),
    risk_flags: overrides.risk_flags ?? ['none'],
    guards: overrides.guards ?? [],
    smoke: overrides.smoke ?? false,
    weekly: overrides.weekly ?? false,
  };
}

function makeMatrix(cells: MatrixCell[]): Matrix {
  return {
    version: 1,
    generated: '2026-11-08',
    coverage_rule: 'Every Muse report ends with a COVERAGE section: one line per cell attempted, in the form `<cell id> | PASS|FAIL|BLOCKED | <issue refs or ->`.',
    accounts: { free: 'muse-free@inflecto.ai' },
    budget: { smoke_est_mcp_calls: 3, full_pass_est_mcp_calls: 91 },
    cells,
  };
}

function makeGmail(mails: MuseMail[]): ReadonlyPlannerGmail {
  return {
    users: {
      messages: {
        async list() {
          return { data: { messages: mails.map(m => ({ id: m.id })) } };
        },
        async get({ id }) {
          const mail = mails.find(m => m.id === id);
          if (!mail) throw new Error(`Message not found: ${id}`);
          return {
            data: {
              id: mail.id,
              internalDate: String(mail.time),
              payload: {
                headers: [{ name: 'subject', value: mail.subject }],
                parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(mail.body, 'utf8').toString('base64url') } }],
              },
            },
          };
        },
      },
    },
  };
}

function makeGh(opts: {
  matrix: Matrix;
  issues?: GitHubIssue[];
  targetIssue?: GitHubIssue | null;
  labels?: { name: string }[];
}) {
  const calls: string[][] = [];
  const labels = [...(opts.labels ?? [{ name: 'muse-brief' }])];
  const issues = [...(opts.issues ?? [])];
  let currentTargetIssue = opts.targetIssue ?? null;

  const gh: Gh = async args => {
    calls.push(args);
    if (args[0] === 'api' && args[1].includes('muse-coverage-matrix.json')) {
      return Buffer.from(JSON.stringify(opts.matrix)).toString('base64');
    }
    if (args[0] === 'issue' && args[1] === 'list' && args.includes('muse-test')) {
      return JSON.stringify(issues);
    }
    if (args[0] === 'issue' && args[1] === 'list' && args.includes('muse-brief')) {
      return JSON.stringify(currentTargetIssue ? [currentTargetIssue] : []);
    }
    if (args[0] === 'label' && args[1] === 'list') {
      return JSON.stringify(labels);
    }
    if (args[0] === 'label' && args[1] === 'create') {
      labels.push({ name: args[2] });
      return '';
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      const titleIdx = args.indexOf('--title');
      const bodyIdx = args.indexOf('--body');
      currentTargetIssue = {
        number: 4040,
        title: args[titleIdx + 1],
        body: args[bodyIdx + 1],
        state: 'OPEN',
      };
      return 'https://github.com/kmdesle/inflecto-ai/issues/4040\n';
    }
    if (args[0] === 'issue' && args[1] === 'edit') {
      const bodyIdx = args.indexOf('--body');
      if (currentTargetIssue) {
        currentTargetIssue.body = args[bodyIdx + 1];
      }
      return '';
    }
    throw new Error(`Unexpected gh call: ${args.join(' ')}`);
  };

  return { gh, calls, getTargetIssue: () => currentTargetIssue };
}

test('1. coverage parsing incl. malformed lines and unknown ids', () => {
  const validIds = new Set(['cell-1', 'cell-2', 'cell-3']);
  const emailBody = `
Random preliminary text discussing testing.
Another line with notes.

COVERAGE
cell-1 | PASS | -
malformed line with no pipes
cell-unknown | PASS | -
cell-2 | FAIL | #2258, #2260
cell-3 | BLOCKED | login quota exceeded
cell-1 | INVALID_STATUS | -
| | |
`;

  const records = parseCoverageSection(emailBody, validIds);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], { cellId: 'cell-1', result: 'PASS', issueRefs: [] });
  assert.deepEqual(records[1], { cellId: 'cell-2', result: 'FAIL', issueRefs: ['#2258', '#2260'] });
  assert.deepEqual(records[2], { cellId: 'cell-3', result: 'BLOCKED', issueRefs: ['login quota exceeded'] });
});

test('2. ledger update ordering and once-only application', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const cells = [makeCell('cell-1'), makeCell('cell-2')];
    const matrix = makeMatrix(cells);

    // Two emails arriving out of order in Gmail list
    const mailEarlier: MuseMail = {
      id: 'msg-1',
      subject: '[Muse] Spec Run 1',
      time: Date.parse('2026-11-08T09:00:00Z'),
      body: 'COVERAGE\ncell-1 | FAIL | #100\n',
    };
    const mailLater: MuseMail = {
      id: 'msg-2',
      subject: 'Muse Inflecto test Run 2',
      time: Date.parse('2026-11-08T10:00:00Z'),
      body: 'COVERAGE\ncell-1 | PASS | -\n',
    };

    // Returned out of order: mailLater first
    const gmail = makeGmail([mailLater, mailEarlier]);
    const { gh } = makeGh({ matrix });

    // First run: apply updates ledger
    const res1 = await runPlanner({ gh, gmail, statePath, apply: true, now: Date.parse('2026-11-08T11:00:00Z') });

    // Check that msg-1 was applied first, then msg-2
    const cell1 = res1.state.cells['cell-1'];
    assert.equal(cell1.runs, 2);
    assert.equal(cell1.last_result, 'PASS');
    assert.equal(cell1.last_run, '2026-11-08T10:00:00.000Z');
    assert.equal(cell1.last_pass, '2026-11-08T10:00:00.000Z');
    assert.equal(cell1.last_fail, '2026-11-08T09:00:00.000Z');
    assert.deepEqual(cell1.issue_refs, ['#100']);
    assert.deepEqual(res1.state.processed_message_ids.sort(), ['msg-1', 'msg-2']);

    // Second run: same emails must be skipped
    const res2 = await runPlanner({ gh, gmail, statePath, apply: true, now: Date.parse('2026-11-08T12:00:00Z') });
    const cell1Run2 = res2.state.cells['cell-1'];
    assert.equal(cell1Run2.runs, 2); // not incremented
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('3. retest selection by closedAt', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const c1 = makeCell('c-retest-older', { guards: [101] });
    const c2 = makeCell('c-retest-newer', { guards: [102] });
    const c3 = makeCell('c-retest-never', { guards: [103] });
    const c4 = makeCell('c-open-guard', { guards: [104] });
    const matrix = makeMatrix([c1, c2, c3, c4]);

    const issues: GitHubIssue[] = [
      { number: 101, state: 'CLOSED', closedAt: '2026-11-08T10:00:00Z', title: 'Issue 101' },
      { number: 102, state: 'CLOSED', closedAt: '2026-11-08T10:00:00Z', title: 'Issue 102' },
      { number: 103, state: 'CLOSED', closedAt: '2026-11-08T10:00:00Z', title: 'Issue 103' },
      { number: 104, state: 'OPEN', closedAt: null, title: 'Issue 104' },
    ];

    // Email giving c1 last_run 09:00 (older than closedAt 10:00) and c2 last_run 11:00 (newer)
    const mail: MuseMail = {
      id: 'm1',
      subject: '[Muse] Spec Test',
      time: Date.parse('2026-11-08T09:00:00Z'),
      body: 'COVERAGE\nc-retest-older | FAIL | #101\n',
    };
    const mail2: MuseMail = {
      id: 'm2',
      subject: '[Muse] Spec Test',
      time: Date.parse('2026-11-08T11:00:00Z'),
      body: 'COVERAGE\nc-retest-newer | FAIL | #102\n',
    };

    const gmail = makeGmail([mail, mail2]);
    const { gh } = makeGh({ matrix, issues });

    const res = await runPlanner({ gh, gmail, statePath, apply: true, now: Date.parse('2026-11-08T12:00:00Z') });

    // c-retest-older (last_run 09:00 < closedAt 10:00) and c-retest-never (never run) are in RETEST
    assert.equal(res.retest_count, 2);
    const retestSection = res.brief.split('## SMOKE')[0];
    assert.match(retestSection, /c-retest-older/);
    assert.match(retestSection, /c-retest-never/);
    assert.doesNotMatch(retestSection, /c-retest-newer/);
    assert.doesNotMatch(retestSection, /c-open-guard/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('4. smoke always present', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const s1 = makeCell('smoke-mcp', { smoke: true, est_mcp_calls: 1 });
    const s2 = makeCell('smoke-browser', { surface: 'browser', smoke: true, est_mcp_calls: 0 });
    const matrix = makeMatrix([s1, s2]);

    const gmail = makeGmail([]);
    const { gh } = makeGh({ matrix });

    const res = await runPlanner({ gh, gmail, statePath, now: Date.parse('2026-11-08T12:00:00Z') });
    assert.equal(res.smoke_count, 2);
    assert.match(res.brief, /## SMOKE[\s\S]*smoke-mcp[\s\S]*smoke-browser/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('5. budget cap 35 calls / 2 browser cells in normal mode', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    // 15 MCP cells each costing 3 calls = 45 calls total
    const mcpCells = Array.from({ length: 15 }, (_, i) => makeCell(`mcp-${i}`, { est_mcp_calls: 3 }));
    // 5 browser cells
    const browserCells = Array.from({ length: 5 }, (_, i) => makeCell(`browser-${i}`, { surface: 'browser', est_mcp_calls: 0 }));
    const matrix = makeMatrix([...mcpCells, ...browserCells]);

    const gmail = makeGmail([]);
    const { gh } = makeGh({ matrix });

    // Non-daily walk hour (e.g. 09:00 HST = 19:00 UTC)
    const now = Date.parse('2026-11-08T19:00:00Z');
    const res = await runPlanner({ gh, gmail, statePath, now });

    assert.equal(res.mode, 'NORMAL');
    // Planned MCP calls should not exceed 30 (leaving 5 for exploratory)
    const selectedMcpCells = matrix.cells.filter(c => c.surface === 'mcp' && res.brief.includes(`### \`${c.id}\``));
    const totalMcpCalls = selectedMcpCells.reduce((sum, c) => sum + c.est_mcp_calls, 0);
    assert(totalMcpCalls <= 30, `totalMcpCalls was ${totalMcpCalls}, should be <= 30`);

    // Browser cells should be capped at at most 2
    const selectedBrowserCells = matrix.cells.filter(c => c.surface === 'browser' && res.brief.includes(`### \`${c.id}\``));
    assert(selectedBrowserCells.length <= 2, `selectedBrowserCells was ${selectedBrowserCells.length}, should be <= 2`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('6. RETEST_ONLY mode at 16 open issues', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const s1 = makeCell('smoke-cell', { smoke: true });
    const f1 = makeCell('fill-cell');
    const matrix = makeMatrix([s1, f1]);

    // 16 open issues
    const issues: GitHubIssue[] = Array.from({ length: 16 }, (_, i) => ({
      number: 2000 + i,
      state: 'OPEN',
      title: `Open issue ${i}`,
    }));

    const gmail = makeGmail([]);
    const { gh } = makeGh({ matrix, issues });

    const res = await runPlanner({ gh, gmail, statePath, now: Date.parse('2026-11-08T12:00:00Z') });
    assert.equal(res.mode, 'RETEST_ONLY');
    assert.match(res.brief, /\*\*Mode\*\*:\s*RETEST_ONLY/);
    assert.match(res.brief, /Open muse-test issues/);
    // Fill cell should NOT be included
    assert.doesNotMatch(res.brief, /### `fill-cell`/);
    assert.doesNotMatch(res.brief, /## EXPLORATORY/);

    // 15 open issues -> NORMAL mode
    const issues15 = issues.slice(0, 15);
    const { gh: gh15 } = makeGh({ matrix, issues: issues15 });
    const res15 = await runPlanner({ gh: gh15, gmail, statePath, now: Date.parse('2026-11-08T12:00:00Z') });
    assert.equal(res15.mode, 'NORMAL');
    assert.match(res15.brief, /## EXPLORATORY/);
    assert.match(res15.brief, /### `fill-cell`/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('7. daily full walk fires once per HST day', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const b1 = makeCell('b-1', { surface: 'browser' });
    const b2 = makeCell('b-2', { surface: 'browser' });
    const b3 = makeCell('b-3', { surface: 'browser' });
    const b4 = makeCell('b-4', { surface: 'browser' });
    const matrix = makeMatrix([b1, b2, b3, b4]);

    const gmail = makeGmail([]);
    const { gh } = makeGh({ matrix });

    // 10:00 HST is 20:00 UTC (10 + 10 = 20)
    const run1Time = Date.parse('2026-11-08T20:00:00Z');
    const res1 = await runPlanner({ gh, gmail, statePath, apply: true, now: run1Time });

    // First run on/after 10:00 HST: all 4 browser cells in DAILY-WALK
    assert.equal(res1.daily_walk_count, 4);
    assert.match(res1.brief, /## DAILY-WALK[\s\S]*b-1[\s\S]*b-2[\s\S]*b-3[\s\S]*b-4/);
    assert.equal(res1.state.last_daily_walk, '2026-11-08');

    // Second run on the same HST day at 11:00 HST (21:00 UTC)
    const run2Time = Date.parse('2026-11-08T21:00:00Z');
    const res2 = await runPlanner({ gh, gmail, statePath, apply: true, now: run2Time });
    // Should NOT trigger daily walk again today
    assert.equal(res2.daily_walk_count, 0);

    // Run before 10:00 HST on next day (09:00 HST on 2026-11-09 is 19:00 UTC)
    const run3Time = Date.parse('2026-11-09T19:00:00Z');
    const res3 = await runPlanner({ gh, gmail, statePath, apply: true, now: run3Time });
    assert.equal(res3.daily_walk_count, 0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('8. weekly Sunday rule', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const w1 = makeCell('w-1', { weekly: true });
    const matrix = makeMatrix([w1]);

    const gmail = makeGmail([]);
    const { gh } = makeGh({ matrix });

    // 2026-11-08 is Sunday (UTC 12:00 -> HST 02:00 on Sunday)
    const sundayHst = Date.parse('2026-11-08T12:00:00Z');
    const resSunday = await runPlanner({ gh, gmail, statePath, now: sundayHst });
    assert.equal(resSunday.weekly_count, 1);
    assert.match(resSunday.brief, /## WEEKLY[\s\S]*w-1/);

    // 2026-11-09 is Monday (UTC 12:00 -> HST 02:00 on Monday)
    const mondayHst = Date.parse('2026-11-09T12:00:00Z');
    const resMonday = await runPlanner({ gh, gmail, statePath, now: mondayHst });
    assert.equal(resMonday.weekly_count, 0);
    assert.match(resMonday.brief, /## WEEKLY\n\(none\)/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('9. idempotent brief', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const c1 = makeCell('c-1');
    const matrix = makeMatrix([c1]);
    const gmail = makeGmail([]);

    // First run creates brief
    const res1 = await runPlanner({ gh: makeGh({ matrix }).gh, gmail, statePath, now: Date.parse('2026-11-08T12:00:00Z') });

    // Seed target issue with brief from run 1
    const targetIssue: GitHubIssue = {
      number: 5555,
      title: 'Muse next-run brief (auto-generated, do not edit)',
      body: res1.brief,
      state: 'OPEN',
    };

    const { gh, calls } = makeGh({ matrix, targetIssue });

    // Run again with a newer timestamp (13:00 UTC) with --apply
    const res2 = await runPlanner({ gh, gmail, statePath, apply: true, now: Date.parse('2026-11-08T13:00:00Z') });
    assert.equal(res2.target_issue.action, 'skipped');
    // gh issue edit was NOT called!
    assert.equal(calls.some(c => c[0] === 'issue' && c[1] === 'edit'), false);

    // Now change the matrix so brief content differs
    const matrix2 = makeMatrix([c1, makeCell('c-2')]);
    const { gh: gh2, calls: calls2 } = makeGh({ matrix: matrix2, targetIssue });
    const res3 = await runPlanner({ gh: gh2, gmail, statePath, apply: true, now: Date.parse('2026-11-08T14:00:00Z') });
    assert.equal(res3.target_issue.action, 'edited');
    assert.equal(calls2.some(c => c[0] === 'issue' && c[1] === 'edit'), true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('10. --dry-run writes nothing', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const c1 = makeCell('c-1');
    const matrix = makeMatrix([c1]);
    const gmail = makeGmail([]);
    const { gh, calls } = makeGh({ matrix });

    // Dry-run (apply: false)
    const res = await runPlanner({ gh, gmail, statePath, apply: false, now: Date.parse('2026-11-08T12:00:00Z') });

    // Check ledger was not written to disk
    let fileExists = true;
    try {
      await readFile(statePath, 'utf8');
    } catch {
      fileExists = false;
    }
    assert.equal(fileExists, false, 'ledger.json should not exist in dry run');

    // Check no mutating gh calls occurred
    const writeCalls = calls.filter(c =>
      (c[0] === 'issue' && (c[1] === 'create' || c[1] === 'edit')) ||
      (c[0] === 'label' && c[1] === 'create')
    );
    assert.equal(writeCalls.length, 0, 'No write gh calls in dry run');
    assert.equal(res.target_issue.action, 'would_create');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('11. parseArgs and scoreboard calculations', () => {
  assert.deepEqual(parseArgs([]), { apply: false });
  assert.deepEqual(parseArgs(['--dry-run']), { apply: false });
  assert.deepEqual(parseArgs(['--apply']), { apply: true });
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /Usage/);
  assert.throws(() => parseArgs(['--unknown']), /Usage/);

  const now = Date.parse('2026-11-08T12:00:00Z');
  const cells = [makeCell('c-1'), makeCell('c-2'), makeCell('c-3'), makeCell('c-4')];
  const ledger = {
    'c-1': { last_result: 'PASS' as const, last_run: '2026-11-07T12:00:00Z', last_pass: '2026-11-07T12:00:00Z', last_fail: null, runs: 1, issue_refs: [] },
    'c-2': { last_result: 'FAIL' as const, last_run: '2026-11-07T12:00:00Z', last_pass: null, last_fail: '2026-11-07T12:00:00Z', runs: 1, issue_refs: ['#1'] },
    'c-3': { last_result: 'BLOCKED' as const, last_run: '2026-11-07T12:00:00Z', last_pass: null, last_fail: null, runs: 1, issue_refs: [] },
    'c-4': { last_result: null, last_run: null, last_pass: null, last_fail: null, runs: 0, issue_refs: [] },
  };

  const sb = computeScoreboard(cells, ledger, now);
  assert.equal(sb.total, 4);
  assert.equal(sb.passed_7d, 1);
  assert.equal(sb.coverage_pct, 25.0);
  assert.equal(sb.fails, 1);
  assert.equal(sb.blocked, 1);
  assert.equal(sb.never_run, 1);
});
