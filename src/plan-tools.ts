import {
  writeFile,
  mkdir,
  readdir,
  rmdir,
  unlink,
  rename,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { parsePlanBundle } from './bundle.js';
import {
  serializeRequirementsBlock,
  serializeRoadmapBlock,
  serializeStateBlock,
} from './doc-parse.js';
import { renderContextSections } from './doc-render.js';
import {
  ParseError,
  parsePlanningContext,
  parseReviewResult,
} from './parse.js';
import { readTemplate } from './templates.js';
import {
  ENTRY,
  type GsdPlanFinalized,
  type GsdPlanningContext,
  type GsdPlanReviewCycle,
  type GsdReviewResult,
  type GsdStoredCandidatePlan,
  type PlanningContext,
  type ReviewEntry,
  type ReviewReadFingerprint,
} from './types.js';

type PlanningToolAPI = Pick<ExtensionAPI, 'appendEntry'>;

type ReviewPlanParams = {
  candidatePlan: string;
  planningContext: string;
  reviewOutput: string;
  reviewStatus?: 'completed' | 'aborted' | 'stopped' | 'error';
};

type BranchSessionManager = {
  getBranch(): Array<{ type?: string; customType?: string; data?: unknown }>;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

const isReviewEntryArray = (v: unknown): v is ReviewEntry[] =>
  Array.isArray(v) && v.every(isReviewEntry);

function isReviewEntry(v: unknown): boolean {
  if (typeof v === 'string') return v.length > 0;
  if (!isRecord(v)) return false;
  if (typeof v.issue !== 'string' || v.issue.length === 0) return false;
  if (v.fix !== undefined && typeof v.fix !== 'string') return false;
  return true;
}

function asBranchSessionManager(value: unknown): BranchSessionManager | null {
  if (!isRecord(value) || typeof value.getBranch !== 'function') return null;
  return value as unknown as BranchSessionManager;
}

function isPlanReviewCycleData(value: unknown): value is GsdPlanReviewCycle {
  if (!isRecord(value) || typeof value.iteration !== 'number') return false;
  if (
    typeof value.candidatePlan !== 'string' ||
    typeof value.raw !== 'string'
  ) {
    return false;
  }
  if (value.ok === true) {
    return (
      (value.status === 'needs-revision' || value.status === 'clean') &&
      isReviewResultData(value.review)
    );
  }
  return (
    value.ok === false &&
    (value.status === 'error' ||
      value.status === 'aborted' ||
      value.status === 'stopped' ||
      value.status === 'parse') &&
    typeof value.message === 'string'
  );
}

function isReviewResultData(value: unknown): value is GsdReviewResult {
  if (
    !isRecord(value) ||
    !isReviewEntryArray(value.blockers) ||
    !isReviewEntryArray(value.warnings) ||
    !isReviewEntryArray(value.nitpicks) ||
    typeof value.summary !== 'string'
  ) {
    return false;
  }
  if (value.reviewReadFingerprint === undefined) return true;
  return isFingerprint(value.reviewReadFingerprint);
}

function isFingerprint(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.firstLine === 'string' && typeof value.lastLine === 'string'
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((v) => typeof v === 'string' && v.length > 0)
  );
}

function isStoredCandidatePlanData(
  value: unknown,
): value is GsdStoredCandidatePlan {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  if (typeof value.iteration !== 'number') return false;
  if (typeof value.path !== 'string' || value.path.length === 0) return false;
  if (typeof value.plan !== 'string') return false;
  return true;
}

function findStoredCandidatePlan(
  sessionManager: unknown,
  id: string,
): GsdStoredCandidatePlan | undefined {
  const session = asBranchSessionManager(sessionManager);
  if (!session) return undefined;
  const branch = session.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (
      entry.type === 'custom' &&
      entry.customType === ENTRY.storedCandidatePlan &&
      isStoredCandidatePlanData(entry.data) &&
      entry.data.id === id
    ) {
      return entry.data;
    }
  }
  return undefined;
}

/** Random 16-char hex id used to reference a stored candidate plan. */
function newCandidatePlanId(): string {
  return randomBytes(8).toString('hex');
}

function isPlanningContextData(value: unknown): value is GsdPlanningContext {
  if (!isRecord(value)) return false;
  if (typeof value.iteration !== 'number') return false;
  if (typeof value.objective !== 'string' || value.objective.length === 0) {
    return false;
  }
  return (
    isStringArray(value.constraints) &&
    isStringArray(value.nonGoals) &&
    isStringArray(value.assumptions) &&
    isStringArray(value.deferredItems) &&
    isStringArray(value.repoFindings)
  );
}

function latestPlanningContext(
  sessionManager: unknown,
): GsdPlanningContext | undefined {
  const session = asBranchSessionManager(sessionManager);
  if (!session) return undefined;
  const branch = session.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (
      entry.type === 'custom' &&
      entry.customType === ENTRY.planningContext &&
      isPlanningContextData(entry.data)
    ) {
      return entry.data;
    }
  }
  return undefined;
}

function latestPlanReviewCycle(
  sessionManager: unknown,
): GsdPlanReviewCycle | undefined {
  const session = asBranchSessionManager(sessionManager);
  if (!session) return undefined;
  const branch = session.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (
      entry.type === 'custom' &&
      entry.customType === ENTRY.planReviewCycle &&
      isPlanReviewCycleData(entry.data)
    ) {
      return entry.data;
    }
  }
  return undefined;
}

function nextPlanReviewIteration(sessionManager: unknown): number {
  const latest = latestPlanReviewCycle(sessionManager);
  return latest ? latest.iteration + 1 : 1;
}

/**
 * The earliest persisted planning context, i.e. iteration 1. Treat this as the
 * pinned contract for the whole review loop: any subsequent cycle whose
 * `planningContext` payload diverges from this is a context-drift signal that
 * must be surfaced to the user before the cycle is accepted.
 */
function pinnedPlanningContext(
  sessionManager: unknown,
): GsdPlanningContext | undefined {
  const session = asBranchSessionManager(sessionManager);
  if (!session) return undefined;
  const branch = session.getBranch();
  for (const entry of branch) {
    if (
      entry.type === 'custom' &&
      entry.customType === ENTRY.planningContext &&
      isPlanningContextData(entry.data)
    ) {
      return entry.data;
    }
  }
  return undefined;
}

/**
 * Deep-equal the PlanningContext fields (everything except the iteration
 * counter) of two persisted contexts. Used to detect drift between the pinned
 * iteration-1 context and the context the model just re-supplied.
 */
function planningContextEquals(
  a: PlanningContext,
  b: PlanningContext,
): boolean {
  return (
    a.objective === b.objective &&
    arrayEqual(a.constraints, b.constraints) &&
    arrayEqual(a.nonGoals, b.nonGoals) &&
    arrayEqual(a.assumptions, b.assumptions) &&
    arrayEqual(a.deferredItems, b.deferredItems) &&
    arrayEqual(a.repoFindings, b.repoFindings)
  );
}

function arrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Diff a fresh context against the pinned iteration-1 context, field by field. */
function diffPlanningContext(
  pinned: PlanningContext,
  fresh: PlanningContext,
): string[] {
  const diffs: string[] = [];
  if (pinned.objective !== fresh.objective) {
    diffs.push('objective');
  }
  diffArrayField('constraints', pinned.constraints, fresh.constraints, diffs);
  diffArrayField('nonGoals', pinned.nonGoals, fresh.nonGoals, diffs);
  diffArrayField('assumptions', pinned.assumptions, fresh.assumptions, diffs);
  diffArrayField(
    'deferredItems',
    pinned.deferredItems,
    fresh.deferredItems,
    diffs,
  );
  diffArrayField(
    'repoFindings',
    pinned.repoFindings,
    fresh.repoFindings,
    diffs,
  );
  return diffs;
}

function diffArrayField(
  name: string,
  pinnedArr: readonly string[],
  freshArr: readonly string[],
  diffs: string[],
): void {
  if (pinnedArr.length !== freshArr.length) {
    diffs.push(`${name}(len ${pinnedArr.length}->${freshArr.length})`);
    return;
  }
  for (let i = 0; i < pinnedArr.length; i++) {
    if (pinnedArr[i] !== freshArr[i]) {
      diffs.push(`${name}[${i}]`);
    }
  }
}

function normalizePlan(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

/**
 * Cheap-but-verifiable fingerprint of a plan: the first and last non-empty
 * trimmed lines. The reviewer can read both values straight from the file
 * it scored, and `validate-plan` recomputes them from the stored plan. This
 * closes the 'reviewer read a different file' gap without asking the model
 * to count raw lines (which it is likely to get off-by-one on a trailing
 * newline). It does not catch surgical middle-only edits; if that gap bites
 * in practice, add a known sentinel line.
 */
export function planFingerprint(plan: string): ReviewReadFingerprint {
  const trimmed = plan
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim());
  const firstNonEmpty = trimmed.find((l) => l.length > 0) ?? '';
  const lastNonEmpty = [...trimmed].reverse().find((l) => l.length > 0) ?? '';
  return {
    firstLine: firstNonEmpty,
    lastLine: lastNonEmpty,
  };
}

function fingerprintEquals(
  a: ReviewReadFingerprint,
  b: ReviewReadFingerprint,
): boolean {
  return a.firstLine === b.firstLine && a.lastLine === b.lastLine;
}

/**
 * Best-effort cleanup of `.gpd/candidate-plans/` after a successful
 * finalize. The persisted review cycle already holds the exact plan bytes
 * via `candidatePlan`, so nothing is lost; this just prevents the directory
 * from accumulating one file per review cycle. We remove every entry
 * (not only `.md`) so no junk is ever left behind, then remove the empty
 * directory itself. `store-candidate-plan` will recreate it on the next
 * invocation. Errors are swallowed because cleanup is non-critical.
 *
 * The contents are flat by construction (`<id>.md` files written by
 * `store-candidate-plan`, plus stray OS files like `.DS_Store`), so we use
 * entry-by-entry unlink + rmdir. If cleanup ever needs to handle arbitrary
 * nested contents, swap the body for `rm(dir, { recursive: true, force:
 * true })` and the swallow-on-error semantics still apply.
 */
async function clearStoredCandidatePlans(cwd: string): Promise<void> {
  const dir = join(cwd, '.gpd', 'candidate-plans');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries.map((name) => unlink(join(dir, name)).catch(() => {})),
  );
  await rmdir(dir).catch(() => {});
}

/**
 * Write a set of docs as atomically as the filesystem allows: stage every
 * target as a sibling temp file first, and only once ALL content is written
 * commit them with `rename()`. A content-write failure unlinks every staged
 * temp and throws before any target is touched, so a failed expansion can
 * never leave a half-written SET of docs (the per-file torn-write guarantee
 * of temp+rename, extended across the multi-doc finalize).
 *
 * This is not fully transactional across the rename loop itself — rename is an
 * atomic metadata op, so the residual window (a crash BETWEEN two renames) is
 * far smaller than the previous write-then-rename-per-file ordering, but a
 * crash there could still leave some docs committed and others not. Full
 * cross-file transactionality would need a journal we deliberately do not
 * build (sequential single-writer model).
 */
async function atomicWriteAll(
  entries: ReadonlyArray<{ path: string; content: string }>,
): Promise<void> {
  const staged: Array<{ tmp: string; path: string }> = [];
  try {
    for (const { path, content } of entries) {
      const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, content, 'utf8');
      staged.push({ tmp, path });
    }
  } catch (err) {
    await Promise.all(staged.map((s) => unlink(s.tmp).catch(() => {})));
    throw err;
  }
  // All content is staged; commit with renames.
  for (const { tmp, path } of staged) {
    await rename(tmp, path);
  }
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** A phase id is exactly `NN` (two or more digits). */
function isValidPhaseId(id: string): boolean {
  return /^\d{2,}$/.test(id);
}

/** A plan id is exactly `NN-MM` (two or more digits, dash, two or more digits). */
function isValidPlanId(id: string): boolean {
  return /^\d{2,}-\d{2,}$/.test(id);
}

function replaceJsonBlock(templateText: string, newBlock: string): string {
  const replaced = templateText.replace(/```json[\s\S]*?```/, newBlock);
  return ensureTrailingNewline(replaced);
}

function reqIdSet(bundle: ReturnType<typeof parsePlanBundle>): Set<string> {
  return new Set(bundle.requirements.requirements.map((r) => r.id));
}

function unresolvedReqIds(
  bundle: ReturnType<typeof parsePlanBundle>,
): string[] {
  const validReqIds = reqIdSet(bundle);
  const referenced = new Set<string>(bundle.plan.reqIds);
  for (const slice of bundle.plan.slices) {
    for (const reqId of slice.reqIds) referenced.add(reqId);
  }
  return [...referenced].filter((reqId) => !validReqIds.has(reqId));
}

function sliceReqIdsNotClaimed(
  bundle: ReturnType<typeof parsePlanBundle>,
): string[] {
  const claimed = new Set(bundle.plan.reqIds);
  const missing = new Set<string>();
  for (const slice of bundle.plan.slices) {
    for (const reqId of slice.reqIds) {
      if (!claimed.has(reqId)) missing.add(reqId);
    }
  }
  return [...missing];
}

function uncoveredClaimedReqIds(
  bundle: ReturnType<typeof parsePlanBundle>,
): string[] {
  if (bundle.plan.reqIds.length === 0) return [];
  const covered = new Set<string>();
  for (const slice of bundle.plan.slices) {
    for (const reqId of slice.reqIds) covered.add(reqId);
  }
  return bundle.plan.reqIds.filter((reqId) => !covered.has(reqId));
}

function badRoadmapReqRefs(
  bundle: ReturnType<typeof parsePlanBundle>,
): string[] {
  const validReqIds = reqIdSet(bundle);
  const bad = new Set<string>();
  for (const phase of bundle.roadmap.phases) {
    for (const reqId of phase.reqIds) {
      if (!validReqIds.has(reqId)) bad.add(reqId);
    }
  }
  return [...bad];
}

function statePointerIsValid(
  bundle: ReturnType<typeof parsePlanBundle>,
): boolean {
  if (bundle.state.pointer === null) return true;
  return bundle.state.plans.some((plan) => plan.id === bundle.state.pointer);
}

function planIsPlanned(bundle: ReturnType<typeof parsePlanBundle>): boolean {
  return bundle.state.plans.some(
    (plan) => plan.id === bundle.plan.id && plan.status === 'planned',
  );
}

function summarizeReview(review: GsdReviewResult): string {
  const head = [
    `blockers=${review.blockers.length}`,
    `warnings=${review.warnings.length}`,
    `nitpicks=${review.nitpicks.length}`,
  ].join(' ');
  const sample = pickTopIssues(review);
  return sample
    ? `${head} | ${sample} | ${review.summary}`
    : `${head} | ${review.summary}`;
}

function pickTopIssues(review: GsdReviewResult): string {
  const blockerIssues = review.blockers
    .slice(0, 2)
    .map((e) => formatEntry('blocker', e));
  const warningIssues = review.warnings
    .slice(0, 1)
    .map((e) => formatEntry('warning', e));
  return [...blockerIssues, ...warningIssues].join('; ');
}

function formatEntry(kind: 'blocker' | 'warning', entry: ReviewEntry): string {
  return `${kind}: ${entry.issue}`;
}

function buildCycleFromReview(
  iteration: number,
  candidatePlan: string,
  raw: string,
  review: GsdReviewResult,
): GsdPlanReviewCycle {
  return {
    iteration,
    ok: true,
    candidatePlan,
    raw,
    review,
    status:
      review.blockers.length > 0 || review.warnings.length > 0
        ? 'needs-revision'
        : 'clean',
  };
}

function buildCycleFailure(
  iteration: number,
  candidatePlan: string,
  status: 'error' | 'aborted' | 'stopped' | 'parse',
  raw: string,
  message: string,
): GsdPlanReviewCycle {
  return {
    iteration,
    ok: false,
    candidatePlan,
    raw,
    status,
    message,
  };
}

export function toolValidatePlan(pi: PlanningToolAPI): ToolDefinition {
  return defineTool({
    name: 'validate-plan',
    label: 'Validate Plan',
    description:
      'Resolve a stored candidate plan bundle by id, parse plan-reviewer subagent output, persist the latest hard-gated review cycle, and summarize whether another revision is required. This tool does not review the bundle itself.',
    promptSnippet:
      'After the plan-reviewer subagent reviews the candidate plan bundle, pass its full output into validate-plan with the candidatePlanId returned by store-candidate-plan.',
    promptGuidelines: [
      'Always store the candidate plan bundle first via store-candidate-plan, then call the plan-reviewer subagent with the returned path, then call validate-plan with the same candidatePlanId.',
      'This tool only parses and persists that review result; it does not perform the review itself.',
      'If the review subagent failed or was aborted, set reviewStatus so the failed cycle is persisted instead of silently dropping it.',
      'The stored plan bundle is the single source of truth: the reviewer reads it from disk, and validate-plan persists the exact same bytes. Never re-pass the bundle as inline text.',
      'Pin the planningContext at the first review cycle. If a later cycle re-supplies a planningContext whose objective/constraints/nonGoals/assumptions/deferredItems/repoFindings differ from iteration 1, the tool will refuse unless contextDriftAcknowledged is set.',
      'Only finalize when the latest persisted review cycle is clean.',
      'Pass the planningContext as a JSON string containing objective, constraints, nonGoals, assumptions, deferredItems, and repoFindings.',
    ],
    parameters: Type.Object({
      candidatePlanId: Type.String(),
      planningContext: Type.String(),
      reviewOutput: Type.String(),
      reviewStatus: Type.Optional(
        Type.Union([
          Type.Literal('completed'),
          Type.Literal('aborted'),
          Type.Literal('stopped'),
          Type.Literal('error'),
        ]),
      ),
      contextDriftAcknowledged: Type.Optional(Type.Boolean()),
    }),
    renderCall(args) {
      return new Text(String(args.candidatePlanId), 0, 0);
    },
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const iteration = nextPlanReviewIteration(ctx.sessionManager);
      const candidatePlanId = String(params.candidatePlanId);
      const raw = (params.reviewOutput as string).trim();
      const reviewStatus =
        (params.reviewStatus as ReviewPlanParams['reviewStatus']) ??
        'completed';
      const contextDriftAcknowledged = params.contextDriftAcknowledged === true;

      const stored = findStoredCandidatePlan(
        ctx.sessionManager,
        candidatePlanId,
      );
      if (!stored) {
        return simpleResult(
          `Cannot validate plan: no stored candidate plan found for id ${candidatePlanId}. Call store-candidate-plan first, then re-call validate-plan with the returned id.`,
          { ok: false, reason: 'unknown-candidate-plan-id' },
        );
      }
      if (stored.iteration !== iteration) {
        return simpleResult(
          `Cannot validate plan: stored candidate plan ${candidatePlanId} was prepared for iteration ${stored.iteration} but validate-plan is on iteration ${iteration}. Re-store the plan (store-candidate-plan) and re-run the reviewer.`,
          {
            ok: false,
            reason: 'iteration-mismatch',
            storedIteration: stored.iteration,
            currentIteration: iteration,
          },
        );
      }
      const candidatePlan = stored.plan;

      let context: PlanningContext;
      try {
        context = parsePlanningContext(params.planningContext as string);
      } catch (error) {
        const message =
          error instanceof ParseError
            ? error.message
            : 'Failed to parse planningContext.';
        return simpleResult(`Cannot validate plan: ${message}`, {
          ok: false,
          reason: 'planning-context-parse',
        });
      }

      const pinned = pinnedPlanningContext(ctx.sessionManager);
      if (pinned && !planningContextEquals(pinned, context)) {
        if (!contextDriftAcknowledged) {
          const diffs = diffPlanningContext(pinned, context);
          return simpleResult(
            `Cannot validate plan: planningContext for iteration ${iteration} diverges from the pinned iteration-1 context (changed: ${diffs.join(', ')}). This usually means the contract is mutating mid-loop. Surface the diff to the user, and only retry this call with contextDriftAcknowledged: true if the user explicitly accepts the change.`,
            {
              ok: false,
              reason: 'context-drift',
              changedFields: diffs,
              pinnedIteration: pinned.iteration,
            },
          );
        }
      }

      pi.appendEntry(ENTRY.planningContext, { iteration, ...context });

      if (reviewStatus !== 'completed') {
        const message =
          raw || `plan-reviewer finished with status ${reviewStatus}.`;
        const cycle = buildCycleFailure(
          iteration,
          candidatePlan,
          reviewStatus,
          raw,
          message,
        );
        pi.appendEntry(ENTRY.planReviewCycle, cycle);
        return simpleResult(
          `${message} Recovery: rerun plan-reviewer once and call validate-plan again; if the second attempt also fails, stop and surface the failed cycle to the user.`,
          cycle,
        );
      }

      try {
        const review = parseReviewResult(raw);
        if (review.reviewReadFingerprint !== undefined) {
          const expected = planFingerprint(candidatePlan);
          if (!fingerprintEquals(review.reviewReadFingerprint, expected)) {
            const message =
              'plan-reviewer echoed a reviewReadFingerprint that does not match the stored candidate plan; refusing to persist a cycle whose reviewed text is not provably the stored text. Re-read the stored plan file at the path returned by store-candidate-plan and re-call validate-plan.';
            const cycle = buildCycleFailure(
              iteration,
              candidatePlan,
              'parse',
              raw,
              message,
            );
            pi.appendEntry(ENTRY.planReviewCycle, cycle);
            return simpleResult(message, cycle);
          }
        }
        const cycle = buildCycleFromReview(
          iteration,
          candidatePlan,
          raw,
          review,
        );
        pi.appendEntry(ENTRY.planReviewCycle, cycle);
        return simpleResult(summarizeReview(review), cycle);
      } catch (error) {
        const message =
          error instanceof ParseError
            ? error.message
            : 'Failed to parse plan-reviewer output.';
        const cycle = buildCycleFailure(
          iteration,
          candidatePlan,
          'parse',
          raw,
          `${message} Recovery: rerun plan-reviewer once and call validate-plan again; if the second attempt also fails, stop and surface the failed cycle to the user.`,
        );
        pi.appendEntry(ENTRY.planReviewCycle, cycle);
        return simpleResult(
          `${message} Recovery: rerun plan-reviewer once and call validate-plan again; if the second attempt also fails, stop and surface the failed cycle to the user.`,
          cycle,
        );
      }
    },
  });
}

export function toolFinalizePlan(pi: PlanningToolAPI): ToolDefinition {
  return defineTool({
    name: 'finalize-plan',
    label: 'Finalize Plan',
    description:
      'Expand a reviewed plan bundle into phase CONTEXT/PLAN artifacts and the REQUIREMENTS/ROADMAP/STATE living docs only when the latest persisted review cycle has no blockers, a planning context was captured, and the markdown matches the reviewed candidate bundle. Warnings must be zero or explicitly accepted via acceptWarnings.',
    promptSnippet:
      'Call finalize-plan only after the latest validate-plan result has no blockers and a planning context was captured. Pass the exact reviewed plan bundle markdown. Pass acceptWarnings: true only when the user has explicitly accepted the remaining warnings.',
    promptGuidelines: [
      'Pass the exact final plan bundle markdown: the PLAN section plus complete REQUIREMENTS/ROADMAP/STATE json sections delimited by the gpd section markers.',
      'Do not call this if you changed the candidate bundle after the latest clean review; rerun validate-plan first.',
      'Set acceptWarnings: true only when the user has explicitly chosen to accept the remaining warnings; blockers can never be accepted.',
      'Ensure validate-plan was called with a planningContext so the rendered CONTEXT artifact can be traced back to the objective and constraints.',
      'This tool writes docs/phases/NN-name/NN-CONTEXT.md, docs/phases/NN-name/NN-MM-PLAN.md, and docs/REQUIREMENTS.md, docs/ROADMAP.md, docs/STATE.md. It does not write PLANS.md.',
    ],
    parameters: Type.Object({
      markdown: Type.String(),
      acceptWarnings: Type.Optional(Type.Boolean()),
    }),
    renderCall() {
      return new Text('phase artifacts + living docs', 0, 0);
    },
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const latest = latestPlanReviewCycle(ctx.sessionManager);
      if (!latest) {
        return simpleResult(
          'Cannot finalize plan bundle: no persisted validate-plan result exists yet.',
          { ok: false, reason: 'no-review' },
        );
      }
      if (!latest.ok) {
        return simpleResult(
          `Cannot finalize plan bundle: latest review cycle failed (${latest.status}). Rerun validate-plan after fixing the issue.`,
          { ok: false, reason: latest.status },
        );
      }

      const context = latestPlanningContext(ctx.sessionManager);
      if (!context || context.iteration !== latest.iteration) {
        return simpleResult(
          'Cannot finalize plan bundle: no planning context was captured for the latest review cycle. Call validate-plan with a planningContext first.',
          { ok: false, reason: 'no-planning-context' },
        );
      }

      const acceptWarnings = params.acceptWarnings === true;
      if (latest.review.blockers.length > 0) {
        return simpleResult(
          'Cannot finalize plan bundle: latest review cycle still has blockers. Blockers can never be accepted; revise the bundle and rerun validate-plan.',
          { ok: false, reason: latest.status, review: latest.review },
        );
      }
      const warningCount = latest.review.warnings.length;
      if (warningCount > 0 && !acceptWarnings) {
        return simpleResult(
          `Cannot finalize plan bundle: latest review cycle has ${warningCount} warning(s) but no blockers. Either revise to address them and rerun validate-plan, or set acceptWarnings: true to explicitly accept them.`,
          { ok: false, reason: latest.status, review: latest.review },
        );
      }

      const markdown = params.markdown as string;
      if (normalizePlan(markdown) !== normalizePlan(latest.candidatePlan)) {
        return simpleResult(
          'Cannot finalize plan bundle: markdown differs from the latest clean reviewed candidate bundle. Rerun validate-plan on the updated bundle first.',
          { ok: false, reason: 'stale-review' },
        );
      }

      let bundle: ReturnType<typeof parsePlanBundle>;
      try {
        bundle = parsePlanBundle(markdown);
      } catch (error) {
        const message =
          error instanceof ParseError
            ? error.message
            : 'Failed to parse plan bundle.';
        return simpleResult(`Cannot finalize plan bundle: ${message}`, {
          ok: false,
          reason: 'bundle-parse',
        });
      }

      const unresolved = unresolvedReqIds(bundle);
      if (unresolved.length > 0) {
        return simpleResult(
          `Cannot finalize plan bundle: unresolved requirement id(s): ${unresolved.join(', ')}.`,
          { ok: false, reason: 'unresolved-req', reqIds: unresolved },
        );
      }

      const unclaimed = sliceReqIdsNotClaimed(bundle);
      if (unclaimed.length > 0) {
        return simpleResult(
          `Cannot finalize plan bundle: slice requirement id(s) are not claimed by the plan metadata: ${unclaimed.join(', ')}.`,
          { ok: false, reason: 'slice-req-not-claimed', reqIds: unclaimed },
        );
      }

      const uncovered = uncoveredClaimedReqIds(bundle);
      if (uncovered.length > 0) {
        return simpleResult(
          `Cannot finalize plan bundle: claimed requirement id(s) have no covering slice: ${uncovered.join(', ')}.`,
          { ok: false, reason: 'reverse-coverage', reqIds: uncovered },
        );
      }

      const badRoadmapRefs = badRoadmapReqRefs(bundle);
      if (badRoadmapRefs.length > 0) {
        return simpleResult(
          `Cannot finalize plan bundle: roadmap references unknown requirement id(s): ${badRoadmapRefs.join(', ')}.`,
          { ok: false, reason: 'bad-roadmap-ref', reqIds: badRoadmapRefs },
        );
      }

      if (!statePointerIsValid(bundle)) {
        return simpleResult(
          `Cannot finalize plan bundle: state pointer ${bundle.state.pointer} does not reference a known plan.`,
          {
            ok: false,
            reason: 'bad-state-pointer',
            pointer: bundle.state.pointer,
          },
        );
      }

      if (!planIsPlanned(bundle)) {
        return simpleResult(
          `Cannot finalize plan bundle: state does not mark ${bundle.plan.id} as planned.`,
          { ok: false, reason: 'plan-not-planned', planId: bundle.plan.id },
        );
      }

      // Guard the model-authored ids that flow into filesystem paths: a
      // malformed or traversal id (`../..`, absolute, slashes) must never
      // resolve a write target outside docs/phases/. Validate BEFORE any
      // path is constructed so a bad id fails closed with zero writes.
      if (!isValidPlanId(bundle.plan.id)) {
        return simpleResult(
          `Cannot finalize plan bundle: plan id ${JSON.stringify(bundle.plan.id)} is not a valid NN-MM id.`,
          { ok: false, reason: 'bad-plan-id', planId: bundle.plan.id },
        );
      }
      if (!isValidPhaseId(bundle.plan.phase)) {
        return simpleResult(
          `Cannot finalize plan bundle: plan phase ${JSON.stringify(bundle.plan.phase)} is not a valid NN phase id.`,
          { ok: false, reason: 'bad-phase-id', phase: bundle.plan.phase },
        );
      }

      const phase = bundle.roadmap.phases.find(
        (candidate) => candidate.id === bundle.plan.phase,
      );
      if (!phase) {
        return simpleResult(
          `Cannot finalize plan bundle: unknown roadmap phase ${bundle.plan.phase}.`,
          { ok: false, reason: 'unknown-phase', phase: bundle.plan.phase },
        );
      }
      if (!isValidPhaseId(phase.id)) {
        return simpleResult(
          `Cannot finalize plan bundle: roadmap phase id ${JSON.stringify(phase.id)} is not a valid NN phase id.`,
          { ok: false, reason: 'bad-phase-id', phase: phase.id },
        );
      }

      const phaseDir = `docs/phases/${phase.id}-${slug(phase.name)}`;
      const paths = [
        `${phaseDir}/${phase.id}-CONTEXT.md`,
        `${phaseDir}/${bundle.plan.id}-PLAN.md`,
        'docs/REQUIREMENTS.md',
        'docs/ROADMAP.md',
        'docs/STATE.md',
      ];
      const contextMarkdown = ensureTrailingNewline(
        `# Phase ${phase.id}: ${phase.name}\n\n${renderContextSections(context)}`,
      );
      const requirementsMarkdown = replaceJsonBlock(
        await readTemplate('REQUIREMENTS'),
        serializeRequirementsBlock(bundle.requirements),
      );
      const roadmapMarkdown = replaceJsonBlock(
        await readTemplate('ROADMAP'),
        serializeRoadmapBlock(bundle.roadmap),
      );
      const stateMarkdown = replaceJsonBlock(
        await readTemplate('STATE'),
        serializeStateBlock(bundle.state),
      );

      await atomicWriteAll([
        { path: join(ctx.cwd, paths[0] ?? ''), content: contextMarkdown },
        {
          path: join(ctx.cwd, paths[1] ?? ''),
          content: ensureTrailingNewline(bundle.planMarkdown),
        },
        {
          path: join(ctx.cwd, 'docs', 'REQUIREMENTS.md'),
          content: requirementsMarkdown,
        },
        { path: join(ctx.cwd, 'docs', 'ROADMAP.md'), content: roadmapMarkdown },
        { path: join(ctx.cwd, 'docs', 'STATE.md'), content: stateMarkdown },
      ]);
      await clearStoredCandidatePlans(ctx.cwd);

      const finalized: GsdPlanFinalized = {
        iteration: latest.iteration,
        planId: bundle.plan.id,
        paths,
        ...(warningCount > 0 ? { acceptedWarnings: warningCount } : {}),
      };
      pi.appendEntry(ENTRY.planFinalized, finalized);
      const warningText =
        warningCount > 0
          ? ` (${warningCount} warning(s) explicitly accepted)`
          : '';
      return simpleResult(
        `Finalized plan ${bundle.plan.id}: wrote ${paths.join(', ')}${warningText}.`,
        {
          ok: true,
          planId: bundle.plan.id,
          paths,
          iteration: latest.iteration,
          acceptedWarnings: warningCount,
        },
      );
    },
  });
}

/**
 * Store a candidate plan on disk and persist a session entry that resolves
 * its id to the stored bytes.
 *
 * The stored plan is the single source of truth for one review cycle:
 *   - the planner passes the returned path to `plan-reviewer`, which `read`s
 *     the file directly so the reviewer scores exactly what is stored
 *   - `validate-plan` looks up the entry by `candidatePlanId` and uses the
 *     same bytes to build the persisted review cycle
 *
 * This removes the "two copies of the plan" problem: there is no opportunity
 * to paraphrase the plan between the reviewer's prompt and `validate-plan`,
 * because there is only one copy and both reference it.
 */
export function toolStoreCandidatePlan(pi: PlanningToolAPI): ToolDefinition {
  return defineTool({
    name: 'store-candidate-plan',
    label: 'Store Candidate Plan',
    description:
      'Write a candidate plan bundle to disk, persist a session entry that resolves its id to the stored bytes, and return the id and path. Always call this once per review cycle before invoking plan-reviewer and validate-plan.',
    promptSnippet:
      'Call this before plan-reviewer and validate-plan to store the candidate plan bundle; pass the returned candidatePlanId to validate-plan and the returned path to plan-reviewer so it can read the file directly.',
    promptGuidelines: [
      'Call once per review cycle, before invoking plan-reviewer and validate-plan.',
      'Pass the exact same plan bundle string you intend to ship to the reviewer; the stored bytes are what the reviewer scores and what validate-plan persists.',
      'When revising the bundle, call store-candidate-plan again to get a fresh id; do not reuse an old id with different markdown.',
      'When the review returns blockers or warnings, you must re-store the bundle even if the markdown did not change, so each cycle has its own stored artifact.',
    ],
    parameters: Type.Object({
      plan: Type.String(),
    }),
    renderCall(args) {
      return new Text(`store: ${String(args.plan).slice(0, 60)}`, 0, 0);
    },
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const plan = String(params.plan);
      const id = newCandidatePlanId();
      const iteration = nextPlanReviewIteration(ctx.sessionManager);
      const relPath = join('.gpd', 'candidate-plans', `${id}.md`);
      const absPath = join(ctx.cwd, relPath);

      await mkdir(join(ctx.cwd, '.gpd', 'candidate-plans'), {
        recursive: true,
      });
      await writeFile(absPath, plan, 'utf8');

      const stored: GsdStoredCandidatePlan = {
        id,
        iteration,
        path: relPath,
        plan,
      };
      pi.appendEntry(ENTRY.storedCandidatePlan, stored);

      return simpleResult(
        `Stored candidate plan for iteration ${iteration} at ${relPath}. Pass this path to plan-reviewer so it can read the file directly, and pass candidatePlanId "${id}" to validate-plan.`,
        { ok: true, id, path: relPath, iteration },
      );
    },
  });
}

function simpleResult(text: string, details: unknown) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
  };
}
