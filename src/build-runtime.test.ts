import assert from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  digestSliceResult,
  latestChangeReviewCycle,
  lastAssistantStopReason,
  parseSliceResult,
  renderSliceResult,
  resolveOutcome,
  runSliceOnBranch,
  sliceResultRelPath,
  SLICE_RESULT_MESSAGE_TYPE,
  spawnsReviewer,
  TimeoutError,
  withTimeout,
  writeSliceResult,
  type BranchEntry,
  type BranchPrimitives,
  type SliceResultHandoff,
  type SliceResultInput,
} from './build-runtime.js';
import { ENTRY, type GsdChangeReviewCycle, type ReviewEntry } from './types.js';

function cleanInput(): SliceResultInput {
  return {
    planId: '05-01',
    sliceIndex: 2,
    outcome: 'clean',
    counts: { blockers: 0, warnings: 0, nitpicks: 1 },
    verify: { command: 'npm run verify', exitCode: 0, ok: true },
    summaryPath: '.gpd/candidate-changes/abc.md',
    commitRange: 'aaaa..bbbb',
  };
}

test('renderSliceResult/parseSliceResult round-trips a clean result', () => {
  const input = cleanInput();
  const rendered = renderSliceResult(input);
  const parsed = parseSliceResult(rendered);
  assert.deepStrictEqual(parsed, input);
});

test('parseSliceResult round-trips a warnings-only result without optional fields', () => {
  const input: SliceResultInput = {
    planId: '05-02',
    sliceIndex: 0,
    outcome: 'warnings-only',
    counts: { blockers: 0, warnings: 2, nitpicks: 0 },
    verify: { command: null, exitCode: null, ok: true },
  };
  const parsed = parseSliceResult(renderSliceResult(input));
  assert.deepStrictEqual(parsed, input);
  assert.strictEqual(parsed.summaryPath, undefined);
  assert.strictEqual(parsed.commitRange, undefined);
});

test('parseSliceResult rejects a malformed payload', () => {
  assert.throws(
    () => parseSliceResult('```json\n{"planId":"x"}\n```'),
    /malformed payload/,
  );
});

test('writeSliceResult writes a repo-relative artifact and returns path+digest+counts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-runtime-slice-'));
  try {
    const input = cleanInput();
    const handoff = await writeSliceResult(dir, input);

    const expectedRel = sliceResultRelPath(input.planId, input.sliceIndex);
    assert.strictEqual(handoff.path, expectedRel);
    assert.ok(!handoff.path.startsWith('/'), 'path must be repo-relative');

    const onDisk = await readFile(join(dir, handoff.path), 'utf8');
    assert.strictEqual(handoff.digest, digestSliceResult(onDisk));
    assert.deepStrictEqual(handoff.counts, input.counts);
    assert.deepStrictEqual(handoff.verify, input.verify);
    assert.strictEqual(handoff.outcome, 'clean');
    assert.strictEqual(handoff.commitRange, 'aaaa..bbbb');

    // The artifact round-trips back to the input (no transcript stored).
    assert.deepStrictEqual(parseSliceResult(onDisk), input);
    assert.ok(!onDisk.includes('transcript'), 'no raw transcript in artifact');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sliceResultRelPath rejects plan ids that could escape slice-results', () => {
  assert.throws(
    () => sliceResultRelPath('../05-01', 1),
    /unsafe slice-result planId/,
  );
  assert.throws(() => sliceResultRelPath('05-01', -1), /sliceIndex/);
});

test('resolveOutcome: verify failure forces blockers regardless of counts', () => {
  assert.strictEqual(
    resolveOutcome(
      { blockers: 0, warnings: 0, nitpicks: 0 },
      { command: 'npm test', exitCode: 1, ok: false },
    ),
    'blockers',
  );
});

test('resolveOutcome: clean and warnings-only when verify ok', () => {
  const ok = { command: 'v', exitCode: 0, ok: true };
  assert.strictEqual(
    resolveOutcome({ blockers: 0, warnings: 0, nitpicks: 3 }, ok),
    'clean',
  );
  assert.strictEqual(
    resolveOutcome({ blockers: 0, warnings: 1, nitpicks: 0 }, ok),
    'warnings-only',
  );
  assert.strictEqual(
    resolveOutcome({ blockers: 2, warnings: 0, nitpicks: 0 }, ok),
    'blockers',
  );
});

test('latestChangeReviewCycle: returns the last parseable production cycle', () => {
  const branch: BranchEntry[] = [
    cycleEntry({
      review: reviewWithCounts({ blockers: 1 }),
      verify: { command: 'v', exitCode: 1, ok: false },
    }),
    cycleEntry({ review: reviewWithCounts({ nitpicks: 1 }) }),
  ];
  const cycle = latestChangeReviewCycle(branch);
  assert.ok(cycle?.ok);
  assert.strictEqual(cycle.review.blockers.length, 0);
  assert.strictEqual(cycle.review.nitpicks.length, 1);
  assert.strictEqual(cycle.verify.ok, true);
});

test('latestChangeReviewCycle: undefined when newest cycle entry is malformed', () => {
  const branch: BranchEntry[] = [
    cycleEntry({ review: reviewWithCounts({ nitpicks: 1 }) }),
    {
      type: 'custom',
      customType: ENTRY.changeReviewCycle,
      data: { status: 'clean', review: reviewWithCounts() },
    },
  ];
  assert.strictEqual(latestChangeReviewCycle(branch), undefined);
});

test('latestChangeReviewCycle: undefined when no cycle exists', () => {
  assert.strictEqual(latestChangeReviewCycle([]), undefined);
  assert.strictEqual(
    latestChangeReviewCycle([{ type: 'custom', customType: 'other' }]),
    undefined,
  );
});

test('lastAssistantStopReason: reads the last assistant stopReason', () => {
  const branch: BranchEntry[] = [
    { type: 'message', message: { role: 'user' } },
    { type: 'message', message: { role: 'assistant', stopReason: 'stop' } },
    { type: 'message', message: { role: 'assistant', stopReason: 'aborted' } },
  ];
  assert.strictEqual(lastAssistantStopReason(branch), 'aborted');
});

test('withTimeout: resolves when the promise settles first', async () => {
  const result = await withTimeout(Promise.resolve('ok'), 1000);
  assert.strictEqual(result, 'ok');
});

test('withTimeout: rejects with TimeoutError when the promise stalls', async () => {
  const stall = new Promise<void>(() => {});
  await assert.rejects(
    () => withTimeout(stall, 10),
    (err: unknown) => err instanceof TimeoutError,
  );
});

/** A record of primitive calls so tests can assert the round-trip sequencing. */
interface FakeLog {
  navigations: string[];
  userMessages: string[];
  replays: Array<{ customType: string; details: unknown }>;
}

interface FakeOptions {
  /** The branch entries getBranch() returns after the turn (cycle + stop reason). */
  branchAfterTurn: BranchEntry[];
  /** waitForIdle behavior: resolve, reject, or stall forever. */
  waitForIdle: () => Promise<void>;
  leafId?: string | null;
  cancelInitialNavigation?: boolean;
}

function makeFakeBranch(opts: FakeOptions): {
  prims: BranchPrimitives;
  log: FakeLog;
} {
  const log: FakeLog = { navigations: [], userMessages: [], replays: [] };
  const prims: BranchPrimitives = {
    getLeafId: () => (opts.leafId === undefined ? 'parent-leaf' : opts.leafId),
    async navigateTree(targetId) {
      log.navigations.push(targetId);
      return {
        cancelled:
          opts.cancelInitialNavigation === true && log.navigations.length === 1,
      };
    },
    sendUserMessage(content) {
      log.userMessages.push(content);
    },
    waitForIdle: opts.waitForIdle,
    getBranch: () => opts.branchAfterTurn,
    sendMessage(message) {
      log.replays.push({
        customType: message.customType,
        details: message.details,
      });
    },
  };
  return { prims, log };
}

function reviewEntries(count: number, prefix: string): ReviewEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    issue: `${prefix} ${i + 1}`,
  }));
}

function reviewWithCounts(
  counts: Partial<{
    blockers: number;
    warnings: number;
    nitpicks: number;
  }> = {},
) {
  return {
    blockers: reviewEntries(counts.blockers ?? 0, 'blocker'),
    warnings: reviewEntries(counts.warnings ?? 0, 'warning'),
    nitpicks: reviewEntries(counts.nitpicks ?? 0, 'nitpick'),
    summary: 'reviewed',
  };
}

type CycleEntryOptions = {
  iteration?: number;
  planId?: string;
  sliceN?: number;
  candidateChange?: string;
  raw?: string;
  verify?: GsdChangeReviewCycle['verify'];
} & (
  | {
      ok?: true;
      review?: Extract<GsdChangeReviewCycle, { ok: true }>['review'];
      status?: Extract<GsdChangeReviewCycle, { ok: true }>['status'];
    }
  | {
      ok: false;
      status?: Extract<GsdChangeReviewCycle, { ok: false }>['status'];
      message?: string;
    }
);

function cycleEntry(cycle: CycleEntryOptions = {}): BranchEntry {
  const common = {
    iteration: cycle.iteration ?? 1,
    planId: cycle.planId ?? '05-01',
    sliceN: cycle.sliceN ?? 0,
    candidateChange:
      cycle.candidateChange ?? '.gpd/candidate-changes/change.md',
    raw: cycle.raw ?? '{}',
  };
  const data: GsdChangeReviewCycle =
    cycle.ok === false
      ? {
          ...common,
          ok: false,
          verify: cycle.verify ?? {
            command: 'npm run verify',
            exitCode: 1,
            ok: false,
          },
          status: cycle.status ?? 'error',
          message: cycle.message ?? 'cycle failed',
        }
      : {
          ...common,
          ok: true,
          review: cycle.review ?? reviewWithCounts(),
          verify: cycle.verify ?? {
            command: 'npm run verify',
            exitCode: 0,
            ok: true,
          },
          status: cycle.status ?? 'clean',
        };
  return {
    type: 'custom',
    customType: ENTRY.changeReviewCycle,
    data,
  };
}

function assistantEntry(stopReason: string): BranchEntry {
  return { type: 'message', message: { role: 'assistant', stopReason } };
}

test('Candidate A spawns the reviewer directly (top-level, no extra machinery)', () => {
  assert.strictEqual(spawnsReviewer.path, 'direct-top-level-subagent');
  assert.strictEqual(spawnsReviewer.extraMachinery, false);
});

test('Candidate A: cancelled branch navigation pauses without sending prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-runtime-a-cancel-'));
  try {
    const { prims, log } = makeFakeBranch({
      branchAfterTurn: [cycleEntry({})],
      waitForIdle: async () => {},
      cancelInitialNavigation: true,
    });

    const result = await runSliceOnBranch(prims, {
      cwd: dir,
      planId: '05-01',
      sliceIndex: 1,
      builderSlicePrompt: 'implement slice 1',
      timeoutMs: 100,
    });

    assert.strictEqual(result.kind, 'interrupted');
    if (result.kind === 'interrupted') {
      assert.strictEqual(result.status, 'paused');
      assert.strictEqual(result.reason, 'aborted');
    }
    assert.deepStrictEqual(log.navigations, ['parent-leaf']);
    assert.deepStrictEqual(log.userMessages, []);
    assert.strictEqual(log.replays.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Candidate A: clean slice round-trip branches, replays, and advances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-runtime-a-clean-'));
  try {
    const { prims, log } = makeFakeBranch({
      branchAfterTurn: [
        assistantEntry('stop'),
        cycleEntry({ sliceN: 3, review: reviewWithCounts({ nitpicks: 1 }) }),
      ],
      waitForIdle: async () => {},
    });

    const result = await runSliceOnBranch(prims, {
      cwd: dir,
      planId: '05-01',
      sliceIndex: 3,
      builderSlicePrompt: 'implement slice 3',
      timeoutMs: 1000,
      commitRange: 'aaaa..bbbb',
    });

    assert.strictEqual(result.kind, 'advance');
    if (result.kind === 'advance') {
      assert.strictEqual(result.outcome, 'clean');
    }

    // Sequencing: branch off parent, then return to parent.
    assert.deepStrictEqual(log.navigations, ['parent-leaf', 'parent-leaf']);
    assert.deepStrictEqual(log.userMessages, ['implement slice 3']);

    // Replay is a data message carrying only path+digest+counts.
    assert.strictEqual(log.replays.length, 1);
    assert.strictEqual(log.replays[0]?.customType, SLICE_RESULT_MESSAGE_TYPE);
    const handoff = log.replays[0]?.details as SliceResultHandoff;
    assert.ok(handoff.path.startsWith('.gpd/slice-results/'));
    assert.deepStrictEqual(handoff.counts, {
      blockers: 0,
      warnings: 0,
      nitpicks: 1,
    });
    assert.strictEqual(handoff.commitRange, 'aaaa..bbbb');

    // The artifact exists on disk and round-trips.
    const onDisk = await readFile(join(dir, handoff.path), 'utf8');
    assert.strictEqual(parseSliceResult(onDisk).outcome, 'clean');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Candidate A: warnings-only slice replays and advances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-runtime-a-warnings-'));
  try {
    const { prims, log } = makeFakeBranch({
      branchAfterTurn: [
        assistantEntry('stop'),
        cycleEntry({
          sliceN: 2,
          review: reviewWithCounts({ warnings: 2 }),
          status: 'needs-revision',
        }),
      ],
      waitForIdle: async () => {},
    });

    const result = await runSliceOnBranch(prims, {
      cwd: dir,
      planId: '05-01',
      sliceIndex: 2,
      builderSlicePrompt: 'implement slice 2',
      timeoutMs: 1000,
    });

    assert.strictEqual(result.kind, 'advance');
    if (result.kind === 'advance') {
      assert.strictEqual(result.outcome, 'warnings-only');
      assert.strictEqual(result.handoff.outcome, 'warnings-only');
      assert.deepStrictEqual(result.handoff.counts, {
        blockers: 0,
        warnings: 2,
        nitpicks: 0,
      });
      const onDisk = await readFile(join(dir, result.handoff.path), 'utf8');
      assert.strictEqual(parseSliceResult(onDisk).outcome, 'warnings-only');
    }
    assert.strictEqual(log.replays.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Candidate A: timeout is interrupted (paused), no replay, no slice-result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-runtime-a-timeout-'));
  try {
    const { prims, log } = makeFakeBranch({
      branchAfterTurn: [cycleEntry({})],
      waitForIdle: () => new Promise<void>(() => {}), // never resolves
    });

    const result = await runSliceOnBranch(prims, {
      cwd: dir,
      planId: '05-01',
      sliceIndex: 1,
      builderSlicePrompt: 'implement slice 1',
      timeoutMs: 10,
    });

    assert.strictEqual(result.kind, 'interrupted');
    if (result.kind === 'interrupted') {
      assert.strictEqual(result.status, 'paused');
      assert.strictEqual(result.reason, 'timeout');
    }
    // No slice-result replay on interruption.
    assert.strictEqual(log.replays.length, 0);
    // Still returned to the parent leaf so the session is not left on the branch.
    assert.deepStrictEqual(log.navigations, ['parent-leaf', 'parent-leaf']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Candidate A: non-timeout waitForIdle rejection is blocked and returns to parent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-runtime-a-wait-error-'));
  try {
    const { prims, log } = makeFakeBranch({
      branchAfterTurn: [cycleEntry({})],
      waitForIdle: async () => {
        throw new Error('model crashed');
      },
    });

    const result = await runSliceOnBranch(prims, {
      cwd: dir,
      planId: '05-01',
      sliceIndex: 1,
      builderSlicePrompt: 'implement slice 1',
      timeoutMs: 100,
    });

    assert.strictEqual(result.kind, 'interrupted');
    if (result.kind === 'interrupted') {
      assert.strictEqual(result.status, 'blocked');
      assert.strictEqual(result.reason, 'error');
    }
    assert.strictEqual(log.replays.length, 0);
    assert.deepStrictEqual(log.navigations, ['parent-leaf', 'parent-leaf']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Candidate A: aborted branch turn is interrupted (paused), no replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-runtime-a-abort-'));
  try {
    const { prims, log } = makeFakeBranch({
      branchAfterTurn: [assistantEntry('aborted')],
      waitForIdle: async () => {},
    });
    const result = await runSliceOnBranch(prims, {
      cwd: dir,
      planId: 'p',
      sliceIndex: 0,
      builderSlicePrompt: 'x',
      timeoutMs: 100,
    });
    assert.strictEqual(result.kind, 'interrupted');
    if (result.kind === 'interrupted') {
      assert.strictEqual(result.status, 'paused');
      assert.strictEqual(result.reason, 'aborted');
    }
    assert.strictEqual(log.replays.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Candidate A: error branch turn is interrupted (blocked), no replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-runtime-a-stop-error-'));
  try {
    const { prims, log } = makeFakeBranch({
      branchAfterTurn: [assistantEntry('error'), cycleEntry({})],
      waitForIdle: async () => {},
    });
    const result = await runSliceOnBranch(prims, {
      cwd: dir,
      planId: '05-01',
      sliceIndex: 1,
      builderSlicePrompt: 'x',
      timeoutMs: 100,
    });
    assert.strictEqual(result.kind, 'interrupted');
    if (result.kind === 'interrupted') {
      assert.strictEqual(result.status, 'blocked');
      assert.strictEqual(result.reason, 'error');
    }
    assert.strictEqual(log.replays.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Candidate A: mismatched cycle planId is interrupted with no replay or artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-runtime-a-plan-mismatch-'));
  try {
    const { prims, log } = makeFakeBranch({
      branchAfterTurn: [
        assistantEntry('stop'),
        cycleEntry({ planId: '05-02', review: reviewWithCounts() }),
      ],
      waitForIdle: async () => {},
    });
    const result = await runSliceOnBranch(prims, {
      cwd: dir,
      planId: '05-01',
      sliceIndex: 0,
      builderSlicePrompt: 'x',
      timeoutMs: 100,
    });
    assert.strictEqual(result.kind, 'interrupted');
    if (result.kind === 'interrupted') {
      assert.strictEqual(result.status, 'blocked');
      assert.strictEqual(result.reason, 'no-cycle');
    }
    assert.deepStrictEqual(log.navigations, ['parent-leaf', 'parent-leaf']);
    assert.strictEqual(log.replays.length, 0);
    await assert.rejects(
      () => readFile(join(dir, sliceResultRelPath('05-01', 0)), 'utf8'),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Candidate A: mismatched cycle sliceN is interrupted with no replay or artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-runtime-a-slice-mismatch-'));
  try {
    const { prims, log } = makeFakeBranch({
      branchAfterTurn: [
        assistantEntry('stop'),
        cycleEntry({ sliceN: 2, review: reviewWithCounts() }),
      ],
      waitForIdle: async () => {},
    });
    const result = await runSliceOnBranch(prims, {
      cwd: dir,
      planId: '05-01',
      sliceIndex: 1,
      builderSlicePrompt: 'x',
      timeoutMs: 100,
    });
    assert.strictEqual(result.kind, 'interrupted');
    if (result.kind === 'interrupted') {
      assert.strictEqual(result.status, 'blocked');
      assert.strictEqual(result.reason, 'no-cycle');
    }
    assert.deepStrictEqual(log.navigations, ['parent-leaf', 'parent-leaf']);
    assert.strictEqual(log.replays.length, 0);
    await assert.rejects(
      () => readFile(join(dir, sliceResultRelPath('05-01', 1)), 'utf8'),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Candidate A: blockers stop the slice with no replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-runtime-a-block-'));
  try {
    const { prims, log } = makeFakeBranch({
      branchAfterTurn: [
        assistantEntry('stop'),
        cycleEntry({
          review: reviewWithCounts({ blockers: 2 }),
          verify: { command: 'v', exitCode: 0, ok: true },
          status: 'needs-revision',
        }),
      ],
      waitForIdle: async () => {},
    });
    const result = await runSliceOnBranch(prims, {
      cwd: dir,
      planId: '05-01',
      sliceIndex: 0,
      builderSlicePrompt: 'x',
      timeoutMs: 100,
    });
    assert.strictEqual(result.kind, 'blocked');
    assert.strictEqual(log.replays.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Candidate A: ok:false change-review-cycle blocks with synthetic blocker count', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-runtime-a-cycle-fail-'));
  try {
    const { prims, log } = makeFakeBranch({
      branchAfterTurn: [
        assistantEntry('stop'),
        cycleEntry({ ok: false, sliceN: 1 }),
      ],
      waitForIdle: async () => {},
    });
    const result = await runSliceOnBranch(prims, {
      cwd: dir,
      planId: '05-01',
      sliceIndex: 1,
      builderSlicePrompt: 'x',
      timeoutMs: 100,
    });
    assert.strictEqual(result.kind, 'blocked');
    if (result.kind === 'blocked') {
      assert.deepStrictEqual(result.counts, {
        blockers: 1,
        warnings: 0,
        nitpicks: 0,
      });
      assert.strictEqual(result.verify.ok, false);
    }
    assert.strictEqual(log.replays.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Candidate A: verify.ok=false blocks even with zero reviewer counts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-runtime-a-verify-'));
  try {
    const { prims, log } = makeFakeBranch({
      branchAfterTurn: [
        assistantEntry('stop'),
        cycleEntry({ verify: { command: 'npm test', exitCode: 1, ok: false } }),
      ],
      waitForIdle: async () => {},
    });
    const result = await runSliceOnBranch(prims, {
      cwd: dir,
      planId: '05-01',
      sliceIndex: 0,
      builderSlicePrompt: 'x',
      timeoutMs: 100,
    });
    assert.strictEqual(result.kind, 'blocked');
    if (result.kind === 'blocked') {
      assert.strictEqual(result.verify.ok, false);
    }
    assert.strictEqual(log.replays.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Candidate A: no parseable cycle is interrupted (blocked), no replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-runtime-a-nocycle-'));
  try {
    const { prims, log } = makeFakeBranch({
      branchAfterTurn: [assistantEntry('stop')],
      waitForIdle: async () => {},
    });
    const result = await runSliceOnBranch(prims, {
      cwd: dir,
      planId: 'p',
      sliceIndex: 0,
      builderSlicePrompt: 'x',
      timeoutMs: 100,
    });
    assert.strictEqual(result.kind, 'interrupted');
    if (result.kind === 'interrupted') {
      assert.strictEqual(result.reason, 'no-cycle');
    }
    assert.strictEqual(log.replays.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
