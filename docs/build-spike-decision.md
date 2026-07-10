# Phase 5, Slice 1 — Executor-primitive comparative SPIKE

Status: DECISION. This is a throwaway prototype whose deliverable is a decision
+ rationale, not shippable runtime. The prototype code under `spike/` exists
only to make the machinery of each candidate real and measurable.

## What the spike had to decide

PLANS.md does not assume the `/build` executor primitive. Two candidates were
prototyped end-to-end for ONE slice, both handing back on the SAME
primitive-agnostic file-based `slice-result` contract (`spike/slice-result.ts`)
so the comparison isolates the executor machinery:

- **Candidate A — command-driven branch round-trip** (`spike/candidate-a-branch.ts`):
  `getLeafId → navigateTree(parent,{summarize:false}) → sendUserMessage(builderSlicePrompt)
  → waitForIdle() (timeout-wrapped) → read the branch leaf's latest
  change-review-cycle from getBranch() → navigateTree(parent) →
  sendMessage(fileBasedSliceResult)`. The branch turn is TOP-LEVEL, so it spawns
  `code-reviewer` directly.
- **Candidate B — in-memory subagent executor** (`spike/candidate-b-inmemory.ts`):
  an isolated `createAgentSession({ sessionManager: SessionManager.inMemory() })`
  executor (mirroring `/plan`'s `subagent` pattern + pdw) that owns
  implement+verify, handing back the same file-based `slice-result`. Because the
  executor is itself a subagent, the recursion guard forbids it from spawning
  `code-reviewer` nested — so the reviewer runs via a NON-NESTED path.

Both prototypes typecheck under `tsc --noEmit`, lint clean, are prettier-clean,
and are unit-tested with injected fakes (24 spike tests, all green), mirroring
the `src/plan-tools.test.ts` injected-`sessionManager` style.

## The recursion-guard constraint (cited, not re-derived)

`@gotgenes/pi-subagents`' `applyRecursionGuard`
(`node_modules/@gotgenes/pi-subagents/src/lifecycle/create-subagent-session.ts`)
strips `["subagent","get_subagent_result","steer_subagent"]` from EVERY child
session:

```ts
const EXCLUDED_TOOL_NAMES = ["subagent", "get_subagent_result", "steer_subagent"];
function applyRecursionGuard(session: AgentSession): void {
  const filtered = session
    .getActiveToolNames()
    .filter((t) => !EXCLUDED_TOOL_NAMES.includes(t));
  session.setActiveToolsByName(filtered);
}
```

Consequence, and the core asymmetry the spike measures:

- **Candidate A's branch turn is a top-level turn** (a real user turn on the
  main session tree), not a child session. It keeps the `subagent` tool and
  spawns `code-reviewer` DIRECTLY. Zero extra machinery for the reviewer path.
  In the prototype this is asserted as a plain fact:
  `spawnsReviewer = { path: 'direct-top-level-subagent', extraMachinery: false }`.
- **Candidate B's executor IS a subagent**, so its `subagent` tool is stripped.
  It cannot invoke `code-reviewer` nested. The reviewer must run via a
  non-nested path — modelled in the prototype as an injected `NonNestedReviewer`
  the ORCHESTRATOR owns, with two concrete strategies:
  1. `orchestrator-driven`: the orchestrator (top-level) runs the `code-reviewer`
     subagent between executor turns and re-prompts the executor with the
     outstanding blockers. The review-until-clean loop must be lifted OUT of the
     executor into the orchestrator.
  2. `direct-completion`: the executor calls a reviewer-model completion directly
     (a raw model call, not a subagent), duplicating what the packaged
     `code-reviewer` subagent already provides (read-only toolset + result
     parsing).

## Comparison table

| Dimension | Candidate A (branch round-trip) | Candidate B (in-memory executor) |
|---|---|---|
| (a) Total machinery / LOC | `candidate-a-branch.ts` ≈ 114 code lines. Injected surface = 6 EXISTING command-frame primitives (`getLeafId`, `navigateTree`, `sendUserMessage`, `waitForIdle`, `getBranch`, `sendMessage`). No new session lifecycle. | `candidate-b-inmemory.ts` ≈ 102 code lines **but understated**: the review-until-clean loop is stubbed behind an injected `NonNestedReviewer` interface. Real cost adds a per-slice `createAgentSession(inMemory())` lifecycle (create + dispose) AND a non-nested reviewer component that does not exist yet. |
| (b) Reviewer path cost | **Direct top-level `subagent` spawn.** Reuses the packaged `code-reviewer` unchanged; the review-until-clean loop lives inside ONE branch turn. Zero extra components. | **Non-nested workaround required.** Either lift the review loop into the orchestrator (extra re-prompt plumbing + inter-turn state) or build a second reviewer-model completion path (duplicates `code-reviewer`). Either way, machinery A does not pay. |
| (c) `waitForIdle` timeout reliability | Wrapped via `withTimeout` (clears the timer on settle). Timeout → interrupted (paused), returns to parent leaf, NO replay, NO finalize. Proven by test. | The EXECUTOR turn is `withTimeout`-wrapped (timeout → interrupted/paused, session disposed in `finally`, NO replay — proven by test). BUT the non-nested `reviewer.review(...)` call is NOT wrapped in this prototype, so a hung orchestrator-driven reviewer or direct-completion would stall. **NOT equivalent, and worse for B:** because the reviewer lives outside the executor turn, B must timeout-wrap a SECOND surface (the reviewer path) that Candidate A gets for free inside its single top-level branch turn. This is additional B machinery, not parity. |
| (d) Does the persistent leaf buy anything the file-based handoff doesn't? | The branch model's ONLY distinctive payoff. The parent leaf accumulates the replayed `slice-result` on the main session tree, so `/build`'s orchestrator, resume, and finalize read cycles from the live session it already owns. | No persistent leaf; the in-memory session is discarded after each slice. **But** the file-based `slice-result` artifact (path + digest + counts + commit range) already covers the durable-handoff need for BOTH candidates — so the persistent leaf's extra value over the file handoff is marginal (mainly: no separate on-disk read to reconstruct parent state). |
| (e) Correctness under the recursion guard | Correct by construction — top-level turn keeps `subagent`. | Correct ONLY with a non-nested reviewer. A naive "executor spawns code-reviewer" is silently impossible (tools stripped), a real footgun. |

## Should the spike adopt `@gotgenes/pi-session-tools`' `readSessionFileEntries`?

**Decision: NO** (default stance confirmed). The file-based `slice-result`
handoff (`spike/slice-result.ts`) stays the primary and only handoff.

Rationale:
- The optional convenience would let the orchestrator read a branch leaf's
  persisted `change-review-cycle` entries off disk instead of navigating back to
  read them in-session. For Candidate A that saves at most the in-session read,
  but Candidate A reads the branch via `getBranch()` from the live command frame
  BEFORE navigating back (see `runSliceOnBranch`), so there is no navigation
  round-trip to remove — the convenience buys nothing on the chosen candidate.
- Caveats make it a poor dependency for a hard-gate path: the package ships no
  `exports` map, so consumption is a deep import (`.../src/...`) that is fragile
  across version bumps; and reading JSONL while the session process may still be
  writing invites a read-while-write race. A hard-gate resume/finalize path must
  not depend on either.
- It is not installed in the repo (correctly — it was only ever a spike-time
  candidate, never committed). Adopting it would add a dependency for a
  round-trip the winner does not incur.

Adopt only if a future need shows it removes real navigation round-trips
cleanly; it does not here.

## Recommendation: Candidate A (command-driven branch round-trip)

I reached this from what the prototypes actually cost, not from PLANS.md's hint.
The two executor files are within ~12 code lines of each other, so raw LOC is a
wash — but that parity is misleading, and the tie-breakers all point one way:

1. **Reviewer path (dimension b) is decisive.** Candidate A spawns
   `code-reviewer` directly from the top-level branch turn and owns
   review-until-clean inside that single turn — reusing the packaged reviewer
   with zero new components. Candidate B is *forbidden* from nesting the reviewer
   and must either lift the loop into the orchestrator (re-prompt plumbing +
   inter-turn state, visible in `runSliceInMemory`'s explicit cycle loop) or
   build a second reviewer-completion path that duplicates `code-reviewer`.
   Candidate B's spike LOC looks small only because that reviewer is stubbed
   behind `NonNestedReviewer`; in production that machinery is real and A does
   not pay it.
2. **Correctness under the recursion guard (dimension e).** Candidate A is
   correct by construction. Candidate B has a silent footgun — the intuitive
   "executor spawns code-reviewer" simply does not work (tools stripped), and
   getting it right requires deliberately routing around the guard.
3. **Persistent leaf (dimension d).** The one thing the branch model adds over
   the file handoff — cycles accumulating on the live parent session — is a
   genuine (if modest) plus for orchestration/resume/finalize, and it comes for
   free with A. Candidate B gives it up and gains nothing the file-based
   `slice-result` doesn't already provide.
4. **Timeout reliability (dimension c) is a tie** — the `withTimeout` wrapper is
   shared and primitive-agnostic, so it is not a differentiator.

Candidate B would only win if driving the reviewer outside a nested subagent
were *cheaper* than the branch round-trip. The prototype shows the opposite: the
non-nested reviewer is strictly more machinery than a direct tool call, and it
buys nothing in return. So Candidate A wins on both simplicity and correctness.

## What the rest of Phase 5 builds on the winner

The remaining Phase-5 slices (2+) build the per-slice review sub-loop and the
sequential orchestrator on Candidate A:

- The orchestrator loop drives each slice via `runSliceOnBranch`-shaped calls
  from the `/build` command frame, consuming the primitive-agnostic
  `SliceStepResult` (`advance` / `blocked` / `interrupted`) unchanged — the file-based
  `slice-result` contract and outcome-resolution (`resolveOutcome`,
  `latestChangeReviewCycle`, `lastAssistantStopReason`, `withTimeout`) in
  `spike/slice-result.ts` are the reusable, primitive-agnostic core and carry
  forward (re-homed into `src/`, not kept in `spike/`).
- `store-candidate-change` / `validate-change` tools (mirroring
  `store-candidate-plan` / `validate-plan`) run INSIDE the top-level branch turn;
  `code-reviewer` is spawned directly there. `validate-change` records the
  `verify: {command, exitCode, ok}` outcome and refuses a clean/warnings-only
  cycle when `verify.ok` is false.
- The orchestrator maintains the TUI status line + bounded rolling progress log,
  wraps each branch `waitForIdle` in the timeout (interrupted → paused, no
  replay, no finalize), and replays only the compact file-based `slice-result`
  (path + digest + counts + commit range) via `sendMessage` — never the raw
  transcript, never `sendUserMessage`.
- `@gotgenes/pi-session-tools` is NOT taken as a dependency; the file-based
  `slice-result` stays the sole handoff.
