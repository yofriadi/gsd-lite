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
 * from the `gsd-stored-candidate-plan` entry and refuses the cycle as a
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

/** Durable record that PLANS.md was written from a clean review cycle. */
export interface GsdPlanFinalized {
  iteration: number;
  path: 'PLANS.md';
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

/** Custom entry type names used by the current flow. */
export const ENTRY = {
  planReviewCycle: 'gsd-plan-review-cycle',
  planFinalized: 'gsd-plan-finalized',
  planningContext: 'gsd-planning-context',
  storedCandidatePlan: 'gsd-stored-candidate-plan',
} as const;
