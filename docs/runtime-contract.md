# Runtime contract

This file defines the current `gsd-lite` planning runtime.

## Overview

`gsd-lite` exposes one planner command and three hard-gate tools:

- `/plan`
- `store-candidate-plan`
- `validate-plan`
- `finalize-plan`

The planner stays in the foreground. Focused exploration and review happen through synchronous `subagent` calls.

## Filesystem contract

Two classes of file are intended on disk:

- `PLANS.md` — the durable, finalized plan. Written only by `finalize-plan` after a clean persisted review cycle.
- `.gpd/candidate-plans/<id>.md` — per-cycle transient scratch files holding the plan text the reviewer read and `validate-plan` persisted. Written by `store-candidate-plan`. On a successful `finalize-plan` the directory is removed entirely (so no junk is ever left behind); `store-candidate-plan` recreates it on the next invocation. The directory is gitignored. On finalize failure the files are retained so the user can debug what the reviewer actually saw.

Nothing else under `.gpd/` is part of the contract.

## Session-state contract

The current flow persists four custom entries.

### `stored-candidate-plan`

```ts
interface GsdStoredCandidatePlan {
  id: string;          // random 16-char hex
  iteration: number;   // review iteration this plan was prepared for
  path: string;        // repo-relative path to the stored .md file
  plan: string;        // exact stored bytes
}
```

Created by `store-candidate-plan`, which writes the plan to `<cwd>/.gpd/candidate-plans/<id>.md` and appends this entry. The stored plan is the single source of truth for one review cycle: `plan-reviewer` `read`s the file at `path`, and `validate-plan` looks the id back up to resolve the exact bytes for the persisted cycle. The planner cannot paraphrase inline text into two places (the `validate-plan` API no longer takes an inline plan); to verify the reviewer actually read the file, the reviewer should also echo `reviewReadFingerprint` from the file it read. `validate-plan` refuses cycles whose `candidatePlanId` is unknown or whose stored `iteration` does not match the current review iteration.

### `planning-context`

```ts
interface PlanningContext {
  objective: string;
  constraints: string[];
  nonGoals: string[];
  assumptions: string[];
  deferredItems: string[];
  repoFindings: string[];
}

interface GsdPlanningContext extends PlanningContext {
  iteration: number;
}
```

Captured from the interview/explore phase and persisted at the start of every `validate-plan` call. The `planningContext` parameter uses the `PlanningContext` shape; the persisted `planning-context` entry adds the matching review `iteration`. The planning context is the contract against which the `plan-reviewer` judges objective alignment, constraint compliance, and scope control.

Rules:

- `validate-plan` requires a `planningContext` parameter.
- A malformed `planningContext` fails the validation call without persisting a review cycle.
- The same context must be passed to the `plan-reviewer` subagent in its prompt because the reviewer runs with `inherit_context: false`.
- `finalize-plan` requires a persisted planning context whose `iteration` matches the latest review cycle.

### `plan-review-cycle`

```ts
interface ReviewEntry {
  issue: string;    // one-sentence description of the problem (required)
  fix?: string;     // one-sentence concrete fix (omit when obvious)
}

interface ReviewReadFingerprint {
  firstLine: string;
  lastLine: string;
}

interface GsdReviewResult {
  blockers: ReviewEntry[];
  warnings: ReviewEntry[];
  nitpicks: ReviewEntry[];
  summary: string;
  /**
   * Optional cheap-but-verifiable echo of the file the reviewer actually
   * read: `firstLine` and `lastLine` of the plan (non-empty trimmed lines).
   * `validate-plan` recomputes the same fingerprint from the
   * `stored-candidate-plan` entry and refuses the cycle as a `parse`
   * failure if the digests disagree, so the persisted cycle can only
   * describe a plan the reviewer provably read. Absent = trust the reviewer
   * (graceful degradation for older reviewers); cryptographic integrity is
   * not the goal.
   *
   * Deliberately excludes `lineCount`: counting raw lines is exactly the
   * kind of off-by-one (trailing newline, blank lines) an LLM is likely to
   * get slightly wrong, and a false-positive mismatch costs a full
   * re-review cycle. The fingerprint does not catch surgical middle-only
   * edits; if that gap bites in practice, add a known sentinel line.
   */
  reviewReadFingerprint?: ReviewReadFingerprint;
}

type GsdPlanReviewCycle =
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
```

Reviewer output contract:

- Each entry is an object with `issue` (required, non-empty) and `fix` (optional).
- `validate-plan` also accepts plain strings in the arrays for backward compatibility; they are normalized to `{issue: <string>}`.
- `fix` must be a string when present. Non-string values for `fix` cause a parse failure (`status: 'parse'`).

Rules:

- every plan-reviewer pass must be persisted through `validate-plan`
- failed review runs are persisted too
- `status: 'clean'` means blockers and warnings are both empty
- the plan the reviewer scores and the plan `validate-plan` persists are the same bytes because both reference the `stored-candidate-plan` entry; `validate-plan` does not take an inline plan
- when the reviewer includes `reviewReadFingerprint`, `validate-plan` recomputes the same fingerprint from the stored plan and refuses the cycle as a `parse` failure if they disagree. The fingerprint catches "reviewer read a different file than the one stored"; it does not catch every conceivable failure mode (e.g. the reviewer `read`ing the file but scoring something else), but it does close the path-mismatch gap honestly without asking the model to compute a cryptographic digest

### Planning context drift

`validate-plan` pins the planning context at iteration 1: it looks up the earliest `planning-context` entry and compares every later cycle's `planningContext` parameter against it. If `objective`, `constraints`, `nonGoals`, `assumptions`, `deferredItems`, or `repoFindings` differ, `validate-plan` returns a `context-drift` failure and does **not** persist the new cycle, unless the call also sets `contextDriftAcknowledged: true`. Drift is meant to flag silent contract mutation (e.g. an objective narrowed to make blockers disappear) and force the planner to surface the diff to the user before continuing.

### `plan-finalized`

```ts
interface GsdPlanFinalized {
  iteration: number;
  path: 'PLANS.md';
  acceptedWarnings?: number; // count of warnings explicitly accepted at finalization
}
```

Written only after `PLANS.md` is successfully finalized. `acceptedWarnings` is set only when warnings were explicitly accepted via `finalize-plan`'s `acceptWarnings` flag.

## Planner tool surface

During `/plan`, the active tools are:

- `read`
- `find`
- `grep`
- `ls`
- `ask_user_question`
- `subagent`
- `store-candidate-plan`
- `validate-plan`
- `finalize-plan`

Notably absent:

- `write`
- `bash`
- legacy manual-review tools/commands

## Review loop

1. `/plan` starts the interview and repo-grounding flow.
2. The planner uses `codebase-explorer` to ground questions before asking the user.
3. The planner may call synchronous `subagent` for:
   - `codebase-explorer`
   - `github-explorer`
   - `doc-lookup`
   - `plan-reviewer`
4. The planner synthesizes a `planningContext` JSON and a candidate plan in conversation.
5. The planner calls `store-candidate-plan` with the candidate plan. The tool writes the plan to `.gpd/candidate-plans/<id>.md`, persists a `stored-candidate-plan` entry, and returns `{id, path, iteration}`.
6. The planner runs `plan-reviewer` via `subagent`, passing the full `planningContext` and the stored `path` in the prompt. The reviewer `read`s the file directly so it scores the exact stored bytes.
7. The planner passes the `candidatePlanId` (from step 5), raw review output, and the exact `planningContext` JSON into `validate-plan`. `validate-plan` resolves the id back to the stored plan, persists the context as `planning-context`, and persists the review cycle as `plan-review-cycle`.
8. If the persisted result is `needs-revision`, the planner revises and repeats: a new `store-candidate-plan` call yields a fresh id, the reviewer reads the new path, and `validate-plan` looks up the new id.
9. If the latest persisted result is `clean`, the planner may call `finalize-plan`. If the result has warnings but no blockers, the planner may still call `finalize-plan` with `acceptWarnings: true` after the user explicitly accepts the warnings.
10. `finalize-plan` writes `PLANS.md` only when the markdown exactly matches the latest clean reviewed candidate plan and a `planning-context` entry exists for the same review iteration.

## Failure behavior

`finalize-plan` must fail closed when:

- no persisted review cycle exists
- no `planning-context` entry exists for the latest review iteration
- the latest review cycle failed
- the latest review cycle still has blockers (blockers can never be accepted)
- the latest review cycle has warnings and `acceptWarnings` is not set
- the proposed markdown differs from the latest clean reviewed candidate plan

`finalize-plan` accepts warnings when `acceptWarnings: true` is passed; it then records the count in the `plan-finalized` entry.

`validate-plan` must fail safe by persisting parse failures and explicit aborted/stopped/error review statuses.

### Candidate-plan id resolution

`validate-plan` returns `reason: 'unknown-candidate-plan-id'` if no `stored-candidate-plan` entry matches the supplied `candidatePlanId`. It returns `reason: 'iteration-mismatch'` if the matched entry's `iteration` does not equal the current `nextPlanReviewIteration`. In both cases no review cycle is persisted; the planner must call `store-candidate-plan` (or pass the correct id from an existing store) and retry.

### Read-fingerprint mismatch

When the reviewer includes `reviewReadFingerprint`, `validate-plan` recomputes the same fingerprint (`firstLine`, `lastLine` non-empty trimmed lines) from the stored plan. If the digests disagree, the cycle is persisted with `status: 'parse'` and a message explaining the mismatch. The planner should re-call `plan-reviewer`, instructing it to re-`read` the file at the path returned by `store-candidate-plan`, then re-call `validate-plan`. An absent fingerprint is treated as "trust the reviewer" for graceful degradation.

### Failed-cycle recovery

When `validate-plan` persists a failed cycle (`status` is `parse`, `aborted`, `stopped`, or `error`), the tool response text includes a recovery hint telling the planner to rerun `plan-reviewer` once and re-call `validate-plan`. If the second attempt also fails, the planner must stop the loop and surface the failed cycle to the user instead of retrying silently. There is no enforced iteration cap; the planner is responsible for recognising non-converging loops and escalating.

### Planning context drift acknowledgment

`validate-plan` returns `reason: 'context-drift'` and a `changedFields` list when the supplied `planningContext` diverges from the pinned iteration-1 context. To accept the drift and persist the new cycle anyway, the planner must set `contextDriftAcknowledged: true` and only after the user has explicitly accepted the change.
