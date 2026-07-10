/**
 * Entry schemas for the current hard-gated planning flow.
 *
 * See docs/runtime-contract.md for the authoritative runtime contract.
 */

/**
 * Reviewer-emitted review entry. The reviewer subagent emits these as
 * `{issue, fix}` objects so feedback carries the problem and a concrete
 * fix recommendation.
 *
 * `issue` is required. `fix` is optional. The parser also accepts plain
 * strings (treated as `issue` only) for backward compatibility with older
 * reviewer runs.
 */
export interface ReviewEntry {
  issue: string;
  fix?: string;
}

/**
 * Reviewer-emitted review payload parsed from plan-reviewer output.
 *
 * The `reviewReadFingerprint` is the reviewer's cheap-but-verifiable echo of
 * the file it actually read. `validate-plan` recomputes the same fingerprint
 * from the `stored-candidate-plan` entry and refuses the cycle as a
 * `parse` failure if the digests disagree, so the persisted cycle can only
 * describe a plan that the reviewer provably read. Absent = trust the
 * reviewer (graceful degradation for older reviewers).
 *
 * The fingerprint deliberately excludes `lineCount`: counting raw lines is
 * exactly the kind of off-by-one (trailing newline, blank lines) an LLM is
 * likely to get slightly wrong, and a false-positive mismatch costs a full
 * re-review cycle. `firstLine` and `lastLine` are non-empty trimmed lines
 * and are reproducible.
 */
export interface ReviewReadFingerprint {
  firstLine: string;
  lastLine: string;
}

export interface GsdReviewResult {
  blockers: ReviewEntry[];
  warnings: ReviewEntry[];
  nitpicks: ReviewEntry[];
  summary: string;
  reviewReadFingerprint?: ReviewReadFingerprint;
}

/** Captured hard-gated plan review cycle. */
export type GsdPlanReviewCycle =
  | {
      iteration: number;
      ok: true;
      candidatePlan: string;
      raw: string;
      review: GsdReviewResult;
      status: 'needs-revision' | 'clean';
    }
  | {
      iteration: number;
      ok: false;
      candidatePlan: string;
      raw: string;
      status: 'error' | 'aborted' | 'stopped' | 'parse';
      message: string;
    };

/** Durable record that phase artifacts/living docs were written from a clean review cycle. */
export interface GsdPlanFinalized {
  iteration: number;
  planId: string;
  paths: string[];
  /** Number of warnings explicitly accepted at finalization. Omitted when zero. */
  acceptedWarnings?: number;
}

/**
 * Planning context captured during the interview/explore phase and carried
 * through every review cycle so the reviewer can judge alignment against the
 * real objective, constraints, and assumptions.
 */
export interface PlanningContext {
  objective: string;
  constraints: string[];
  nonGoals: string[];
  assumptions: string[];
  deferredItems: string[];
  repoFindings: string[];
}

/** Persisted planning context for one review iteration. */
export interface GsdPlanningContext extends PlanningContext {
  iteration: number;
}

/**
 * The single source of truth for a candidate plan during one review cycle.
 *
 * Created by `store-candidate-plan`: the tool writes the plan text to disk and
 * persists this entry so the planner can hand the `id` to `plan-reviewer` and
 * `validate-plan`. The reviewer `read`s the file at `path`; `validate-plan`
 * resolves the id back to the exact stored bytes. This removes the
 * "two copies of the plan" problem (planner paraphrases plan, reviewer scores
 * one copy, validate-plan stores another) because there is only one copy
 * on disk and both the reviewer and the validator reference it.
 */
export interface GsdStoredCandidatePlan {
  id: string;
  iteration: number;
  path: string;
  plan: string;
}

/* ------------------------------------------------------------------ *
 * Doc-model schemas (living ledger docs + phase artifacts)
 *
 * The three living ledger docs (STATE/ROADMAP/REQUIREMENTS) each embed a
 * single ```json fenced block as their sole machine-parseable source of
 * truth; surrounding prose is freeform and never parsed. NN-MM-PLAN.md is
 * heading-structured (the builder heading-map scans `### Slice <N>`), with a
 * tiny top-of-file JSON metadata block for id/phase/reqIds/verify only.
 * ------------------------------------------------------------------ */

/** Per-plan lifecycle status in the STATE ledger. */
export type PlanStatus = 'pending' | 'planned' | 'built';

/** One plan row in the STATE status ledger. */
export interface StatePlan {
  id: string;
  phase: string;
  status: PlanStatus;
}

/**
 * The next action a cold-started session should run, rendered from the status
 * ledger + execution-context status. Not a durable buffer: finalize tools
 * recompute it on every STATE write.
 */
export interface StateNext {
  /** Command to run next, e.g. '/build' or '/plan'. */
  command: string;
  /** Plan id the command targets, or null when not plan-scoped. */
  planId: string | null;
  /** Human-readable reason, e.g. 'planned-but-unbuilt'. */
  reason: string;
}

/**
 * STATE.md machine block: a per-plan status ledger plus the current pointer.
 * `pointer` is the id of the plan `/build` resolves by default (or null when
 * nothing is pending). It is a ledger, not a single linear cursor.
 */
export interface StateLedger {
  pointer: string | null;
  next: StateNext | null;
  plans: StatePlan[];
}

/** One phase in the ROADMAP: its REQ ids and its ordered plan ids. */
export interface RoadmapPhase {
  id: string;
  name: string;
  reqIds: string[];
  plans: string[];
}

/** ROADMAP.md machine block: ordered phases -> REQ ids + ordered plans. */
export interface RoadmapDoc {
  phases: RoadmapPhase[];
}

/**
 * Verification evidence recorded on a satisfied requirement row: the verify
 * command that gated the closing build and whether it passed. Distinct from
 * the richer per-cycle {@link VerifyResult} (which also carries the raw exit
 * code); this is the auditable summary rendered into REQUIREMENTS.md.
 */
export interface VerifyEvidence {
  command: string | null;
  ok: boolean;
}

/**
 * One requirement row. When satisfied, the closure-evidence fields join the
 * requirement to its verification (per the requirement-closure-evidence
 * decision): who satisfied it, the SUMMARY, who validated it, the verify
 * outcome, and the slice commit range. All closure fields are optional and
 * are rendered by `finalize-build` from data it already has.
 */
export interface Requirement {
  id: string;
  text: string;
  satisfiedBy?: string;
  summary?: string;
  validatedBy?: 'code-reviewer';
  verify?: VerifyEvidence;
  evidence?: string;
}

/** REQUIREMENTS.md machine block: the REQ list + traceability rows. */
export interface RequirementsDoc {
  requirements: Requirement[];
}

/**
 * One slice parsed from NN-MM-PLAN.md. `reqIds` are the REQ ids the slice
 * claims (from the `[REQ-01, REQ-02]` suffix on its heading). `consumes` /
 * `produces` are the inter-slice interface block (symbols/types/artifacts the
 * slice takes from earlier slices and exposes to later ones); an empty array
 * round-trips as an `_none_` marker.
 */
export interface PlanSlice {
  n: number;
  title: string;
  reqIds: string[];
  consumes: string[];
  produces: string[];
}

/**
 * NN-MM-PLAN.md parsed model. `reqIds` are the plan-level REQ ids this plan
 * claims. `verify`, when absent, is resolved from the project default at build
 * time; when present, it is a pinned command or the literal string `none`
 * (explicit no-verify). `outOfScope` is the drift-boundary path/module list;
 * an empty list round-trips as an `_none_` marker. Slice prose is intentionally
 * not modeled: the parser skips it and `finalize-plan` writes reviewed bytes
 * directly.
 */
export interface PlanDoc {
  id: string;
  phase: string;
  reqIds: string[];
  verify?: string;
  outOfScope: string[];
  slices: PlanSlice[];
}

/* ------------------------------------------------------------------ *
 * Build-side session entries
 * ------------------------------------------------------------------ */

/**
 * Status of an in-flight `/build`, so an interrupted run is distinguishable
 * from a clean one on the next invocation. `active` = normal; `paused` =
 * stalled but safe to re-run (aborted turn or timeout); `blocked` = no safe
 * recovery (error, or blockers survived the revise cap).
 */
export type ExecutionStatus = 'active' | 'paused' | 'blocked';

/** Per-invocation `/build` context, persisted when the loop starts. */
export interface GsdExecutionContext {
  planId: string;
  phaseId: string;
  slices: number[];
  reqIds: string[];
  parentLeafId: string;
  status: ExecutionStatus;
}

/**
 * Recorded verify-command outcome for one change-review cycle. `command` and
 * `exitCode` are null when the plan pins `verify: none` (the command is
 * skipped and `ok` is recorded true). A non-zero `exitCode` forces `ok=false`,
 * which can never resolve to a clean/warnings-only cycle.
 */
export interface VerifyResult {
  command: string | null;
  exitCode: number | null;
  ok: boolean;
}

/**
 * Captured hard-gated change-review cycle for one slice. Mirrors
 * {@link GsdPlanReviewCycle} but is keyed to a `planId` + `sliceN` and carries
 * the {@link VerifyResult} alongside the review counts.
 */
export type GsdChangeReviewCycle =
  | {
      iteration: number;
      planId: string;
      sliceN: number;
      ok: true;
      candidateChange: string;
      raw: string;
      review: GsdReviewResult;
      verify: VerifyResult;
      status: 'needs-revision' | 'clean';
    }
  | {
      iteration: number;
      planId: string;
      sliceN: number;
      ok: false;
      candidateChange: string;
      raw: string;
      verify: VerifyResult;
      status: 'error' | 'aborted' | 'stopped' | 'parse';
      message: string;
    };

/**
 * Single source of truth for a candidate change during one review cycle.
 * Mirrors {@link GsdStoredCandidatePlan} but adds the `planId`/`sliceN` the
 * change belongs to. `change` is the stored change-summary doc bytes.
 */
export interface GsdStoredCandidateChange {
  id: string;
  iteration: number;
  planId: string;
  sliceN: number;
  path: string;
  change: string;
  touchedFiles?: string[];
}

/** Durable record that a plan's SUMMARY was written from clean slice cycles. */
export interface GsdBuildFinalized {
  planId: string;
  phaseId: string;
  summaryPath: string;
  reqIds: string[];
  /** Warnings explicitly accepted at finalization. Omitted when zero. */
  acceptedWarnings?: number;
}

/** Custom entry type names used by the current flow. */
export const ENTRY = {
  planReviewCycle: 'plan-review-cycle',
  planFinalized: 'plan-finalized',
  planningContext: 'planning-context',
  storedCandidatePlan: 'stored-candidate-plan',
  executionContext: 'execution-context',
  changeReviewCycle: 'change-review-cycle',
  storedCandidateChange: 'stored-candidate-change',
  buildFinalized: 'build-finalized',
} as const;
