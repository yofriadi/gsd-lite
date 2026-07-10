import {
  runSliceOnBranch,
  type BranchPrimitives,
  type RunSliceOnBranchArgs,
  type SliceStepResult,
} from './build-runtime.js';
import { ENTRY, type GsdExecutionContext, type PlanSlice } from './types.js';

export type BuildNotifyType = 'error' | 'warning' | 'info';

export interface BuildLoopDeps {
  runSlice?: (
    prims: BranchPrimitives,
    args: RunSliceOnBranchArgs,
  ) => Promise<SliceStepResult>;
  prims: BranchPrimitives;
  appendEntry: (customType: string, data: unknown) => void;
  setStatus: (text: string | undefined) => void;
  notify: (message: string, type?: BuildNotifyType) => void;
  renderProgress?: (log: readonly string[]) => void;
  buildSlicePrompt: (
    planId: string,
    slice: PlanSlice,
    planPath: string,
    contextPath: string,
    outOfScope: string[],
    verify: string | undefined,
  ) => string;
  timeoutMs: number;
  progressLogCap?: number;
}

export interface BuildLoopContext {
  cwd: string;
  planId: string;
  phaseId: string;
  slices: PlanSlice[];
  reqIds: string[];
  parentLeafId: string;
  planPath: string;
  contextPath: string;
  outOfScope: string[];
  verify: string | undefined;
}

export interface BuildLoopResult {
  status: 'completed' | 'blocked' | 'paused';
  lastSliceIndex: number;
  progressLog: string[];
}

const DEFAULT_PROGRESS_LOG_CAP = 40;

function executionContext(
  ctx: BuildLoopContext,
  status: GsdExecutionContext['status'],
): GsdExecutionContext {
  return {
    planId: ctx.planId,
    phaseId: ctx.phaseId,
    slices: ctx.slices.map((slice) => slice.n),
    reqIds: ctx.reqIds,
    parentLeafId: ctx.parentLeafId,
    status,
  };
}

function capProgressLog(lines: string[], cap: number): void {
  if (lines.length > cap) lines.splice(0, lines.length - cap);
}

function appendProgress(
  deps: BuildLoopDeps,
  lines: string[],
  cap: number,
  line: string,
): void {
  lines.push(line);
  capProgressLog(lines, cap);
  deps.renderProgress?.([...lines]);
}

function resultSummary(result: SliceStepResult): string {
  switch (result.kind) {
    case 'advance':
      return `advanced (${result.outcome})`;
    case 'blocked':
      return `blocked (blockers=${result.counts.blockers}, warnings=${result.counts.warnings}, verify=${result.verify.ok ? 'ok' : 'failed'})`;
    case 'interrupted':
      return `interrupted (${result.status}/${result.reason})`;
  }
}

/**
 * Sequentially run one plan's slices. The loop persists only execution-context
 * entries; progressLog is bounded display state derived from loop events and
 * returned slice results, not durable state.
 */
export async function runBuildLoop(
  deps: BuildLoopDeps,
  ctx: BuildLoopContext,
): Promise<BuildLoopResult> {
  const runSlice = deps.runSlice ?? runSliceOnBranch;
  const progressLog: string[] = [];
  const progressLogCap = deps.progressLogCap ?? DEFAULT_PROGRESS_LOG_CAP;

  try {
    deps.appendEntry(ENTRY.executionContext, executionContext(ctx, 'active'));

    for (let i = 0; i < ctx.slices.length; i++) {
      const slice = ctx.slices[i];
      deps.setStatus(
        `gpd · ${ctx.planId} · slice ${i + 1}/${ctx.slices.length}`,
      );
      appendProgress(
        deps,
        progressLog,
        progressLogCap,
        `slice ${slice.n} started: ${slice.title}`,
      );

      let result: SliceStepResult;
      try {
        const builderSlicePrompt = deps.buildSlicePrompt(
          ctx.planId,
          slice,
          ctx.planPath,
          ctx.contextPath,
          ctx.outOfScope,
          ctx.verify,
        );
        result = await runSlice(deps.prims, {
          cwd: ctx.cwd,
          planId: ctx.planId,
          sliceIndex: slice.n,
          builderSlicePrompt,
          timeoutMs: deps.timeoutMs,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendProgress(
          deps,
          progressLog,
          progressLogCap,
          `slice ${slice.n} errored: ${message}`,
        );
        deps.appendEntry(
          ENTRY.executionContext,
          executionContext(ctx, 'blocked'),
        );
        deps.notify(
          `Build errored on ${ctx.planId} slice ${slice.n}: ${message}`,
          'error',
        );
        return { status: 'blocked', lastSliceIndex: i, progressLog };
      }
      appendProgress(
        deps,
        progressLog,
        progressLogCap,
        `slice ${slice.n} ${resultSummary(result)}`,
      );

      if (result.kind === 'advance') continue;

      const status = result.kind === 'blocked' ? 'blocked' : result.status;
      deps.appendEntry(ENTRY.executionContext, executionContext(ctx, status));
      deps.notify(
        status === 'blocked'
          ? `Build blocked on ${ctx.planId} slice ${slice.n}.`
          : `Build paused on ${ctx.planId} slice ${slice.n}.`,
        status === 'blocked' ? 'error' : 'warning',
      );
      return { status, lastSliceIndex: i, progressLog };
    }

    return {
      status: 'completed',
      lastSliceIndex: ctx.slices.length - 1,
      progressLog,
    };
  } finally {
    deps.setStatus(undefined);
  }
}
