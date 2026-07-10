/**
 * Primitive-agnostic `/build` slice-result handoff contract and Candidate A
 * branch round-trip driver.
 *
 * The executor branch writes a compact result artifact under
 * `.gpd/slice-results/<planId>-slice-<n>.md`, and the parent receives only the
 * repo-relative artifact path + digest + parsed review counts (and the git
 * commit range when available) — never the raw branch transcript. This module
 * owns that artifact writer/serializer and the round-trippable parser.
 *
 * It also carries the small pieces of data-contract the production `/build`
 * runtime shares across primitives: the `change-review-cycle`-shaped entry the
 * executor produces, how a slice's outcome resolves from `{counts, verify}`
 * (the Slice review outcome semantics), the timeout wrapper around
 * `waitForIdle`, and the command-driven branch round-trip chosen by the Phase 5
 * spike.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { extractJsonBlock } from './parse.js';
import {
  ENTRY,
  type GsdChangeReviewCycle,
  type GsdReviewResult,
  type ReviewEntry,
  type VerifyResult,
} from './types.js';

/** Parsed reviewer counts recorded on a `change-review-cycle`. */
export interface ReviewCounts {
  blockers: number;
  warnings: number;
  nitpicks: number;
}

/**
 * The recorded outcome of the slice's mechanical verify command. A slice can
 * never resolve clean/warnings-only when `ok` is false (a failing verify is a
 * hard blocker independent of the reviewer's counts). `command` is null when
 * the plan pinned `verify: none`.
 */
export type VerifyOutcome = VerifyResult;

/** The three states a slice's latest cycle resolves to (interrupted is not a slice result). */
export type SliceOutcome = 'clean' | 'warnings-only' | 'blockers';

/**
 * A structural view of one session-tree entry, loose enough that a real
 * `SessionEntry` and a test fake both satisfy it. Custom entries carry
 * `customType`/`data`; message entries carry `message` (with `stopReason` on
 * assistant messages).
 */
export interface BranchEntry {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; stopReason?: string };
}

/** Compact payload written to disk and handed back to the parent. */
export interface SliceResultInput {
  planId: string;
  sliceIndex: number;
  outcome: SliceOutcome;
  counts: ReviewCounts;
  verify: VerifyOutcome;
  summaryPath?: string;
  commitRange?: string;
}

/**
 * What the parent receives via `sendMessage` on replay. Deliberately just the
 * repo-relative artifact `path`, a content `digest`, and the parsed `counts`
 * (+ verify/outcome/commit range the orchestrator's decisions use) — no raw
 * transcript. Branch output is data, not user input.
 */
export interface SliceResultHandoff {
  path: string;
  digest: string;
  counts: ReviewCounts;
  verify: VerifyOutcome;
  outcome: SliceOutcome;
  commitRange?: string;
}

/**
 * The primitive-agnostic result of running one slice. The surrounding
 * orchestrator loop consumes this result without depending on the executor
 * primitive.
 */
export type SliceStepResult =
  | {
      kind: 'advance';
      outcome: 'clean' | 'warnings-only';
      handoff: SliceResultHandoff;
    }
  | { kind: 'blocked'; counts: ReviewCounts; verify: VerifyOutcome }
  | {
      kind: 'interrupted';
      status: 'paused' | 'blocked';
      reason: 'timeout' | 'aborted' | 'error' | 'no-cycle';
    };

/**
 * Resolve a slice's outcome from its counts + verify per the Slice review
 * outcome semantics: a failed verify forces blockers regardless of reviewer
 * counts; otherwise blockers > warnings > clean.
 */
export function resolveOutcome(
  counts: ReviewCounts,
  verify: VerifyOutcome,
): SliceOutcome {
  if (!verify.ok) return 'blockers';
  if (counts.blockers > 0) return 'blockers';
  if (counts.warnings > 0) return 'warnings-only';
  return 'clean';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isVerifyOutcome(v: unknown): v is VerifyOutcome {
  if (!isRecord(v)) return false;
  const commandOk = v.command === null || typeof v.command === 'string';
  const exitOk = v.exitCode === null || typeof v.exitCode === 'number';
  return commandOk && exitOk && typeof v.ok === 'boolean';
}

function isReviewEntry(v: unknown): v is ReviewEntry {
  if (!isRecord(v)) return false;
  return (
    typeof v.issue === 'string' &&
    v.issue.length > 0 &&
    (v.fix === undefined || typeof v.fix === 'string')
  );
}

function isReviewEntryArray(v: unknown): v is ReviewEntry[] {
  return Array.isArray(v) && v.every(isReviewEntry);
}

function isReviewResult(v: unknown): v is GsdReviewResult {
  if (!isRecord(v)) return false;
  return (
    isReviewEntryArray(v.blockers) &&
    isReviewEntryArray(v.warnings) &&
    isReviewEntryArray(v.nitpicks) &&
    typeof v.summary === 'string'
  );
}

function isChangeReviewCycle(v: unknown): v is GsdChangeReviewCycle {
  if (!isRecord(v)) return false;
  if (
    typeof v.iteration !== 'number' ||
    typeof v.planId !== 'string' ||
    typeof v.sliceN !== 'number' ||
    typeof v.candidateChange !== 'string' ||
    typeof v.raw !== 'string' ||
    !isVerifyOutcome(v.verify) ||
    typeof v.ok !== 'boolean'
  ) {
    return false;
  }
  if (v.ok === true) {
    return (
      (v.status === 'needs-revision' || v.status === 'clean') &&
      isReviewResult(v.review)
    );
  }
  return (
    (v.status === 'error' ||
      v.status === 'aborted' ||
      v.status === 'stopped' ||
      v.status === 'parse') &&
    typeof v.message === 'string'
  );
}

function countsFromCycle(cycle: GsdChangeReviewCycle): ReviewCounts {
  if (!cycle.ok) {
    return { blockers: 1, warnings: 0, nitpicks: 0 };
  }
  return {
    blockers: cycle.review.blockers.length,
    warnings: cycle.review.warnings.length,
    nitpicks: cycle.review.nitpicks.length,
  };
}

/**
 * Read the latest `change-review-cycle` entry off a branch (root→leaf order,
 * matching the repo's `getBranch` convention in `plan-tools.ts`). Returns
 * undefined when the branch turn produced no parseable cycle — the orchestrator
 * treats that as interrupted.
 */
export function latestChangeReviewCycle(
  branch: readonly BranchEntry[],
  entryType: string = ENTRY.changeReviewCycle,
): GsdChangeReviewCycle | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.customType === entryType) {
      return isChangeReviewCycle(entry.data) ? entry.data : undefined;
    }
  }
  return undefined;
}

/**
 * The `stopReason` of the last assistant message on the branch. Used to detect
 * an interrupted branch turn (`aborted`/`error`) before trusting any cycle.
 */
export function lastAssistantStopReason(
  branch: readonly BranchEntry[],
): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const message = branch[i].message;
    if (message?.role === 'assistant') return message.stopReason;
  }
  return undefined;
}

const PLAN_ID_PATTERN = /^\d{2}-\d{2}$/;

function assertSafeSliceResultTarget(planId: string, sliceIndex: number): void {
  if (!PLAN_ID_PATTERN.test(planId)) {
    throw new Error(
      `unsafe slice-result planId ${JSON.stringify(planId)}; expected NN-MM`,
    );
  }
  if (!Number.isInteger(sliceIndex) || sliceIndex < 0) {
    throw new Error(
      `unsafe slice-result sliceIndex ${String(sliceIndex)}; expected a non-negative integer`,
    );
  }
}

function assertPathUnder(baseDir: string, targetPath: string): void {
  const rel = relative(baseDir, targetPath);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new Error('unsafe slice-result path escapes .gpd/slice-results');
  }
}

/** Repo-relative artifact path. Absolute paths are forbidden in artifacts. */
export function sliceResultRelPath(planId: string, sliceIndex: number): string {
  assertSafeSliceResultTarget(planId, sliceIndex);
  return join('.gpd', 'slice-results', `${planId}-slice-${sliceIndex}.md`);
}

/** sha256 hex digest of the artifact bytes. Cheap content fingerprint for replay. */
export function digestSliceResult(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Render the compact result artifact: a human-readable header plus a fenced
 * JSON block that `parseSliceResult` round-trips. No transcript is included.
 */
export function renderSliceResult(input: SliceResultInput): string {
  const verify = input.verify.command
    ? `${input.verify.command} → exit ${String(input.verify.exitCode)} (ok=${input.verify.ok})`
    : `none (ok=${input.verify.ok})`;
  const lines = [
    `# Slice Result: ${input.planId} slice ${input.sliceIndex}`,
    '',
    `- Outcome: ${input.outcome}`,
    `- Verify: ${verify}`,
    `- Review: blockers=${input.counts.blockers} warnings=${input.counts.warnings} nitpicks=${input.counts.nitpicks}`,
    `- Summary: ${input.summaryPath ?? 'none'}`,
    `- Commit range: ${input.commitRange ?? 'n/a'}`,
    '',
    '```json',
    JSON.stringify(input, null, 2),
    '```',
    '',
  ];
  return lines.join('\n');
}

/** Parse a rendered artifact back into its `SliceResultInput`. */
export function parseSliceResult(content: string): SliceResultInput {
  const raw: unknown = JSON.parse(extractJsonBlock(content));
  if (!isRecord(raw)) {
    throw new Error('slice-result: expected a JSON object');
  }
  if (
    typeof raw.planId !== 'string' ||
    typeof raw.sliceIndex !== 'number' ||
    !isReviewCounts(raw.counts) ||
    !isVerifyOutcome(raw.verify) ||
    !isSliceOutcome(raw.outcome)
  ) {
    throw new Error('slice-result: malformed payload');
  }
  const input: SliceResultInput = {
    planId: raw.planId,
    sliceIndex: raw.sliceIndex,
    outcome: raw.outcome,
    counts: raw.counts,
    verify: raw.verify,
  };
  if (typeof raw.summaryPath === 'string') input.summaryPath = raw.summaryPath;
  if (typeof raw.commitRange === 'string') input.commitRange = raw.commitRange;
  return input;
}

function isReviewCounts(v: unknown): v is ReviewCounts {
  if (!isRecord(v)) return false;
  return (
    typeof v.blockers === 'number' &&
    typeof v.warnings === 'number' &&
    typeof v.nitpicks === 'number'
  );
}

function isSliceOutcome(v: unknown): v is SliceOutcome {
  return v === 'clean' || v === 'warnings-only' || v === 'blockers';
}

/**
 * Write the artifact under `.gpd/slice-results/` and return the compact handoff
 * the parent replays. The stored bytes are the single source of truth; the
 * returned digest lets the parent verify it later without re-reading a
 * transcript.
 */
export async function writeSliceResult(
  cwd: string,
  input: SliceResultInput,
): Promise<SliceResultHandoff> {
  const relPath = sliceResultRelPath(input.planId, input.sliceIndex);
  const content = renderSliceResult(input);
  const sliceResultsDir = resolve(cwd, '.gpd', 'slice-results');
  const targetPath = resolve(cwd, relPath);
  assertPathUnder(sliceResultsDir, targetPath);
  await mkdir(sliceResultsDir, { recursive: true });
  await writeFile(targetPath, content, 'utf8');
  const handoff: SliceResultHandoff = {
    path: relPath,
    digest: digestSliceResult(content),
    counts: input.counts,
    verify: input.verify,
    outcome: input.outcome === 'blockers' ? 'blockers' : input.outcome,
  };
  if (input.commitRange !== undefined) handoff.commitRange = input.commitRange;
  return handoff;
}

/** Timeout sentinel thrown by `withTimeout` and caught as an interrupted slice. */
export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`operation exceeded ${ms}ms timeout`);
    this.name = 'TimeoutError';
  }
}

/**
 * Wrap a `waitForIdle`-style wait with a timeout so a hung subagent or stalled
 * model can never hang the command frame indefinitely. A timeout is treated as
 * interrupted (status paused), not as a slice result. The timer is always
 * cleared so a resolved wait does not leak a pending timeout.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * The command-only primitives Candidate A needs, projected to exactly the calls
 * it makes. In production these are `ctx.sessionManager.getLeafId`,
 * `ctx.navigateTree`, `ctx.waitForIdle`, `ctx.sessionManager.getBranch`,
 * `pi.sendUserMessage`, and `pi.sendMessage`. Narrowing to this interface keeps
 * the runtime honest about which APIs it depends on and makes it fakeable.
 */
export interface BranchPrimitives {
  /** Current leaf entry id — the parent we branch off and return to. */
  getLeafId(): string | null;
  /** Navigate the session tree in place (branch off, or return to, the parent). */
  navigateTree(
    targetId: string,
    options?: { summarize?: boolean; label?: string },
  ): Promise<{ cancelled: boolean }>;
  /** Send the builder-slice prompt as a real user turn (top-level → can spawn code-reviewer). */
  sendUserMessage(content: string): Promise<void> | void;
  /** Wait for the branch turn to finish streaming. Wrapped in a timeout by us. */
  waitForIdle(): Promise<void>;
  /** Read the current branch root→leaf so we can find the latest change-review-cycle. */
  getBranch(): readonly BranchEntry[];
  /** Replay the compact slice-result to the parent as data (not user input). */
  sendMessage(message: {
    customType: string;
    content: string;
    display?: boolean;
    details?: unknown;
  }): Promise<void> | void;
}

export interface RunSliceOnBranchArgs {
  cwd: string;
  planId: string;
  sliceIndex: number;
  /** The builder-slice prompt the branch turn runs (implement → verify → review-until-clean). */
  builderSlicePrompt: string;
  /** Timeout for the branch `waitForIdle`, in ms. Generous default in the real runtime. */
  timeoutMs: number;
  /** Optional git commit range recorded as resume evidence when git is available. */
  commitRange?: string;
}

export const SLICE_RESULT_MESSAGE_TYPE = 'gpd-slice-result';

/**
 * Candidate A can spawn the reviewer directly from the branch turn because that
 * turn is top-level. This is a plain fact about the primitive, surfaced as a
 * value so orchestration can assert on it: Candidate A pays zero extra
 * machinery for the reviewer path.
 */
export const spawnsReviewer = {
  path: 'direct-top-level-subagent',
  extraMachinery: false,
} as const;

/**
 * Drive one slice through the branch round-trip. Returns a primitive-agnostic
 * `SliceStepResult` the surrounding orchestrator loop consumes.
 *
 * Failure/interruption handling mirrors the Slice review outcome semantics:
 *   - timeout on the branch `waitForIdle` → interrupted (paused), no replay.
 *   - branch turn `stopReason` aborted/error → interrupted (paused/blocked), no replay.
 *   - no parseable change-review-cycle → interrupted (blocked), no replay.
 *   - blockers (or verify.ok=false) → blocked, no advance.
 *   - clean / warnings-only → write the file-based slice-result, return to the
 *     parent, replay the compact handoff via sendMessage, and advance.
 */
export async function runSliceOnBranch(
  prims: BranchPrimitives,
  args: RunSliceOnBranchArgs,
): Promise<SliceStepResult> {
  const parentLeafId = prims.getLeafId();
  if (!parentLeafId) {
    // No leaf to branch from: treat as a blocked interruption; nothing to replay.
    return { kind: 'interrupted', status: 'blocked', reason: 'no-cycle' };
  }

  // 1. Branch off the parent leaf (no summary — we want a clean executor turn).
  const branchNavigation = await prims.navigateTree(parentLeafId, {
    summarize: false,
    label: `slice-${args.sliceIndex}`,
  });
  if (branchNavigation.cancelled) {
    return { kind: 'interrupted', status: 'paused', reason: 'aborted' };
  }

  // 2. Kick off the top-level executor turn (it spawns code-reviewer directly).
  await prims.sendUserMessage(args.builderSlicePrompt);

  // 3. Wait for the branch turn, bounded by a timeout.
  try {
    await withTimeout(prims.waitForIdle(), args.timeoutMs);
  } catch (err) {
    await returnToParent(prims, parentLeafId);
    if (err instanceof TimeoutError) {
      // A stall is not corrupt: paused, re-running /build resumes. No replay.
      return { kind: 'interrupted', status: 'paused', reason: 'timeout' };
    }
    return { kind: 'interrupted', status: 'blocked', reason: 'error' };
  }

  // 4. Read the branch leaf. First check the turn did not abort/error.
  const branch = prims.getBranch();
  const stopReason = lastAssistantStopReason(branch);
  if (stopReason === 'aborted' || stopReason === 'error') {
    await returnToParent(prims, parentLeafId);
    return {
      kind: 'interrupted',
      status: stopReason === 'aborted' ? 'paused' : 'blocked',
      reason: stopReason,
    };
  }

  const cycle = latestChangeReviewCycle(branch);
  if (
    !cycle ||
    cycle.planId !== args.planId ||
    cycle.sliceN !== args.sliceIndex
  ) {
    // Turn produced no parseable cycle for this slice: interrupted (blocked). Do not replay.
    await returnToParent(prims, parentLeafId);
    return { kind: 'interrupted', status: 'blocked', reason: 'no-cycle' };
  }

  const counts = countsFromCycle(cycle);
  const outcome = resolveOutcome(counts, cycle.verify);

  // 5. Return to the parent leaf (persistent-leaf model: the parent accumulates
  //    the replayed slice-result on the main session).
  await returnToParent(prims, parentLeafId);

  if (outcome === 'blockers') {
    // Blockers (including verify.ok=false): do not replay a slice-result.
    return { kind: 'blocked', counts, verify: cycle.verify };
  }

  // 6. Write the compact file-based slice-result and replay it as data.
  const input: SliceResultInput = {
    planId: args.planId,
    sliceIndex: args.sliceIndex,
    outcome,
    counts,
    verify: cycle.verify,
  };
  const commitRange = args.commitRange;
  if (commitRange !== undefined) input.commitRange = commitRange;

  const handoff: SliceResultHandoff = await writeSliceResult(args.cwd, input);

  await prims.sendMessage({
    customType: SLICE_RESULT_MESSAGE_TYPE,
    // Parent receives path + digest + counts — not the raw transcript.
    content: `slice-result: ${handoff.path}`,
    display: false,
    details: handoff,
  });

  return { kind: 'advance', outcome, handoff };
}

/** Return the active leaf to the parent so the parent branch accumulates results. */
async function returnToParent(
  prims: BranchPrimitives,
  parentLeafId: string,
): Promise<void> {
  await prims.navigateTree(parentLeafId);
}
