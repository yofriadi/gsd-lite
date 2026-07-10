import assert from 'node:assert';
import { test } from 'node:test';

import {
  runBuildLoop,
  type BuildLoopContext,
  type BuildLoopDeps,
} from './build-orchestrator.js';
import type { BranchPrimitives, SliceStepResult } from './build-runtime.js';
import { ENTRY, type GsdExecutionContext, type PlanSlice } from './types.js';

function slices(): PlanSlice[] {
  return [
    {
      n: 1,
      title: 'first slice',
      reqIds: ['REQ-01'],
      consumes: [],
      produces: ['one'],
    },
    {
      n: 2,
      title: 'second slice',
      reqIds: ['REQ-02'],
      consumes: ['one'],
      produces: ['two'],
    },
    {
      n: 3,
      title: 'third slice',
      reqIds: [],
      consumes: ['two'],
      produces: [],
    },
  ];
}

function context(overrides: Partial<BuildLoopContext> = {}): BuildLoopContext {
  return {
    cwd: '/repo',
    planId: '05-01',
    phaseId: '05',
    slices: slices(),
    reqIds: ['REQ-01', 'REQ-02'],
    parentLeafId: 'parent-leaf',
    planPath: 'docs/phases/05-alpha/05-01-PLAN.md',
    contextPath: 'docs/phases/05-alpha/05-CONTEXT.md',
    outOfScope: ['docs/**'],
    verify: 'npm run verify',
    ...overrides,
  };
}

const prims: BranchPrimitives = {
  getLeafId: () => 'leaf',
  navigateTree: async () => ({ cancelled: false }),
  sendUserMessage: () => {},
  waitForIdle: async () => {},
  getBranch: () => [],
  sendMessage: () => {},
};

function advance(
  outcome: 'clean' | 'warnings-only' = 'clean',
): SliceStepResult {
  return {
    kind: 'advance',
    outcome,
    handoff: {
      path: `.gpd/slice-results/05-01-slice-1.md`,
      digest: 'digest',
      counts: {
        blockers: 0,
        warnings: outcome === 'warnings-only' ? 1 : 0,
        nitpicks: 0,
      },
      verify: { command: 'npm run verify', exitCode: 0, ok: true },
      outcome,
    },
  };
}

function blocked(): SliceStepResult {
  return {
    kind: 'blocked',
    counts: { blockers: 2, warnings: 1, nitpicks: 0 },
    verify: { command: 'npm run verify', exitCode: 0, ok: true },
  };
}

function interrupted(
  status: 'paused' | 'blocked',
  reason: 'timeout' | 'aborted' | 'error' | 'no-cycle',
): SliceStepResult {
  return { kind: 'interrupted', status, reason };
}

function makeHarness(results: SliceStepResult[]) {
  const entries: Array<{ customType: string; data: unknown }> = [];
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const calls: number[] = [];
  return {
    entries,
    statuses,
    notifications,
    calls,
    deps: {
      prims,
      runSlice: async (_p: BranchPrimitives, args: { sliceIndex: number }) => {
        calls.push(args.sliceIndex);
        const result = results.shift();
        if (!result) throw new Error('unexpected slice call');
        return result;
      },
      appendEntry: (customType: string, data: unknown) => {
        entries.push({ customType, data });
      },
      setStatus: (text: string | undefined) => {
        statuses.push(text);
      },
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      buildSlicePrompt: (
        planId: string,
        slice: PlanSlice,
        planPath: string,
        contextPath: string,
      ) => `${planId}:${slice.n}:${planPath}:${contextPath}`,
      timeoutMs: 100,
      progressLogCap: 40,
    },
  };
}

function executionStatuses(
  entries: Array<{ customType: string; data: unknown }>,
) {
  return entries
    .filter((entry) => entry.customType === ENTRY.executionContext)
    .map((entry) => (entry.data as GsdExecutionContext).status);
}

test('all-clean completes, persists active context, and clears status', async () => {
  const harness = makeHarness([advance(), advance(), advance()]);
  const result = await runBuildLoop(harness.deps, context());

  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.lastSliceIndex, 2);
  assert.deepStrictEqual(harness.calls, [1, 2, 3]);
  assert.deepStrictEqual(executionStatuses(harness.entries), ['active']);
  const active = harness.entries[0]?.data as GsdExecutionContext;
  assert.deepStrictEqual(active.slices, [1, 2, 3]);
  assert.strictEqual(active.parentLeafId, 'parent-leaf');
  assert.strictEqual(harness.statuses.at(-1), undefined);
});

test('warnings-only advances and is not a stop condition', async () => {
  const harness = makeHarness([advance('warnings-only'), advance(), advance()]);
  const result = await runBuildLoop(harness.deps, context());

  assert.strictEqual(result.status, 'completed');
  assert.deepStrictEqual(harness.calls, [1, 2, 3]);
  assert.ok(result.progressLog.some((line) => line.includes('warnings-only')));
});

test('blocked slice stops, persists blocked status, and skips later slices', async () => {
  const harness = makeHarness([advance(), blocked(), advance()]);
  const result = await runBuildLoop(harness.deps, context());

  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.lastSliceIndex, 1);
  assert.deepStrictEqual(harness.calls, [1, 2]);
  assert.deepStrictEqual(executionStatuses(harness.entries), [
    'active',
    'blocked',
  ]);
  assert.strictEqual(harness.notifications.at(-1)?.type, 'error');
});

test('interrupted paused stops and persists paused status', async () => {
  const harness = makeHarness([interrupted('paused', 'timeout'), advance()]);
  const result = await runBuildLoop(harness.deps, context());

  assert.strictEqual(result.status, 'paused');
  assert.strictEqual(result.lastSliceIndex, 0);
  assert.deepStrictEqual(executionStatuses(harness.entries), [
    'active',
    'paused',
  ]);
  assert.strictEqual(harness.notifications.at(-1)?.type, 'warning');
});

test('interrupted blocked stops and persists blocked status', async () => {
  const harness = makeHarness([interrupted('blocked', 'error'), advance()]);
  const result = await runBuildLoop(harness.deps, context());

  assert.strictEqual(result.status, 'blocked');
  assert.deepStrictEqual(harness.calls, [1]);
  assert.deepStrictEqual(executionStatuses(harness.entries), [
    'active',
    'blocked',
  ]);
});

test('rolling progress log is capped', async () => {
  const harness = makeHarness([advance(), advance(), advance()]);
  harness.deps.progressLogCap = 3;
  const result = await runBuildLoop(harness.deps, context());

  assert.strictEqual(result.progressLog.length, 3);
  assert.ok(!result.progressLog[0]?.includes('slice 1 started'));
});

test('renderProgress receives the growing capped log after each append', async () => {
  const harness = makeHarness([advance(), advance(), advance()]);
  const rendered: string[][] = [];
  harness.deps.progressLogCap = 3;
  (harness.deps as BuildLoopDeps).renderProgress = (log) => {
    rendered.push([...log]);
  };

  await runBuildLoop(harness.deps, context());

  assert.strictEqual(rendered.length, 6);
  assert.deepStrictEqual(rendered[0], ['slice 1 started: first slice']);
  assert.strictEqual(rendered.at(-1)?.length, 3);
  assert.ok(!rendered.at(-1)?.[0]?.includes('slice 2 started'));
  assert.match(rendered.at(-1)?.at(-1) ?? '', /slice 3 advanced/);
});

test('thrown runSlice persists blocked context, clears status, and skips later slices', async () => {
  const harness = makeHarness([]);
  harness.deps.runSlice = async (_p, args) => {
    harness.calls.push(args.sliceIndex);
    throw new Error('boom');
  };

  const result = await runBuildLoop(harness.deps, context());

  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.lastSliceIndex, 0);
  assert.deepStrictEqual(harness.calls, [1]);
  assert.deepStrictEqual(executionStatuses(harness.entries), [
    'active',
    'blocked',
  ]);
  assert.deepStrictEqual(harness.statuses, [
    'gpd · 05-01 · slice 1/3',
    undefined,
  ]);
  assert.strictEqual(harness.notifications.at(-1)?.type, 'error');
  assert.match(harness.notifications.at(-1)?.message ?? '', /errored/);
});
