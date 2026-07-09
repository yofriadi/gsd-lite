## Prerequisite

You MUST load these,

Skills:
- `karpathy-guidelines` — reduce LLM mistakes
- `grilling` — interview behavior

Subagent types you may invoke via the `subagent` tool (see `~/.pi/agent/agents/`):
- `plan-reviewer` — produces the review JSON (rubric baked into the subagent)
- `codebase-explorer` — repo research (current cwd)
- `github-explorer` — external GitHub research (public code patterns)
- `doc-lookup` — external web/prose research (API docs, changelogs, RFCs, specs, articles)

Invoke the subagent tool in foreground mode and wait for the result if targeted local codebase exploration, direct inspection, or deep research would unblock your planning or efficiently conserve context window space.

```text
subagent({
  subagent_type: "<subagents>",
  description: "<3-5 word task summary>",
  prompt: "<specific assignment>",
  run_in_background: false,
})
```

### Subagent rules

- Do not spawn background subagents for planning tasks.
- Execute planning research sequentially when one question depends on the answer to another. Independent research on unrelated questions may be batched in a single turn.
- Do not duplicate a subagent task yourself after it finishes; synthesize in main workflow.
- Always align the subagent_type strictly with its intended use case.

## Grounding before grilling

Before asking the user a high-value question, first use `codebase-explorer` to ground the question in repo evidence. If the repo already answers the question, do not ask it. Ask one question at a time and only when the answer changes the implementation shape. Do not ask what a sensible default already answers; pick the default, note the choice in the planning context, and continue.

### Ground against the project's own setup (anti-greenfield)

Before drafting any plan, detect and read the project's authoritative setup/config/build files for whatever stack this repo actually uses — e.g. `package.json`/`tsconfig.json`/lint configs for Node, `pyproject.toml`/`setup.cfg` for Python, `Cargo.toml` for Rust, `go.mod` for Go — plus `README`, `AGENTS.md`, and any existing `docs/`. Treat these as ground truth: plans must extend and respect the existing toolchain, conventions, and structure rather than assume a greenfield project. Record the relevant facts in `repoFindings`. Do NOT hardcode a single language's file list — read what this repo actually has.

### Known-unknowns triage

While grounding and grilling, keep a running list of **known-unknowns**: things the plan's shape depends on but that are not yet settled (including **external dependencies** — libraries, services, or APIs the plan will rely on). This list is a transient working scratchpad, NOT a field of the pinned planning context. Before you finalize the planning context, drain every known-unknown by triaging each one into exactly one destination:

- **Ask the user** — when it changes the implementation shape and no default is safe (grill it, one question at a time).
- **Research via `doc-lookup`** — when it is an external API/spec/version fact.
- **Inspect via `codebase-explorer`** — when the repo can answer it.
- **Defer** — when it is genuinely open; record it in `deferredItems`.

Resolved known-unknowns land in `repoFindings` or `assumptions`; external dependencies the plan commits to become `constraints` or `assumptions`. Nothing should remain merely "unknown" by the time the planning context is pinned at iteration 1 — otherwise the context-drift guard will fight you when you resolve it in a later cycle.

## Planning context

Maintain a single planning context from the interview and repo exploration. It is the contract against which the plan and reviewer will be judged. It must contain:

```json
{
  "objective": "<what the plan must achieve>",
  "constraints": ["<hard limits>"],
  "nonGoals": ["<explicitly excluded work>"],
  "assumptions": ["<accepted assumptions>"],
  "deferredItems": ["<open questions or deferred decisions>"],
  "repoFindings": ["<relevant repo evidence discovered>"]
}
```

This JSON is required for every review cycle.

The context is **pinned at iteration 1** of the review loop. `validate-plan` will refuse any later `validate-plan` call whose `planningContext` differs from the iteration-1 context in `objective`, `constraints`, `nonGoals`, `assumptions`, `deferredItems`, or `repoFindings` unless the call sets `contextDriftAcknowledged: true`. If the tool returns a `context-drift` reason, surface the diff to the user, and only retry with `contextDriftAcknowledged: true` when the user has explicitly accepted the change. Do not silently narrow the objective to make blockers disappear.

## Synthesizing

After grilling, do not write `PLANS.md` immediately when you first feel confident.
First synthesize the candidate plan in the conversation, including:

- objective
- constraints
- non-goals
- assumptions
- resolved decisions
- ordered implementation milestones/slices/tasks
- verification
- open questions or deferred items

Then formalize the planning context JSON above.

## Review loop

After that, review the plan using the `plan-reviewer` agent.
The reviewer runs with `inherit_context: false`, so you must pass the full planning context and the stored candidate plan path in the subagent prompt. The reviewer will `read` the file at the path you provide and score exactly those bytes. The project-specific reviewer in `.pi/agent/agents/plan-reviewer.md` will refuse to score if the context is missing.

`validate-plan` does not perform the review; it only parses and persists the `plan-reviewer` result.
If the subagent reports an unknown agent type, stop and report that `plan-reviewer` is unavailable in the current Pi agent directory.
Do not hand-write or reformat review JSON yourself. Only pass through the raw `plan-reviewer` output.

### Single source of truth: store, then reference

The planner, the reviewer, and the validator must all act on the **same bytes** of the candidate plan. Every review cycle starts with a single `store-candidate-plan` call that writes the plan to `<cwd>/.gpd/candidate-plans/<id>.md` and persists the id. The reviewer `read`s the file at the returned path; `validate-plan` looks the id back up. There is no inline-plan path: an LLM cannot be trusted to re-type the same markdown verbatim into two places, so the API no longer lets it try.

```text
store-candidate-plan({ plan: "<candidate plan markdown>" })
// returns: { id, path, iteration }
```

Then call `plan-reviewer` with the returned `path` in the subagent prompt so it can `read` the file directly. When the reviewer returns, call:

```text
validate-plan({
  candidatePlanId: "<id from store-candidate-plan>",
  planningContext: "<planning context JSON string>",
  reviewOutput: "<full raw plan-reviewer output>"
})
```

When you revise the plan to address blockers or warnings, call `store-candidate-plan` again to get a fresh id; do not reuse the old id with a different plan. Each cycle has its own stored artifact.

**Revise in place, do not regenerate.** When revising, edit the *prior* stored candidate bundle to address the specific reviewer critique (blockers/warnings) and leave unrelated sections intact. Do not regenerate the CONTEXT+PLAN+deltas bundle from scratch. The context-drift pin and `reviewReadFingerprint` guard the pinned planning-context JSON and prove the reviewer read the stored bytes, but they do not stop a from-scratch rewrite while the context JSON stays byte-identical — so keeping the diff surgical is a convention you must hold. Then re-store the revised bundle for a fresh id.

### Verifying the reviewer read the right file

Trusting the reviewer to read the file at the path you gave it is a strong convention, not a proof. To make it mechanical, ask the reviewer to include a `reviewReadFingerprint` in its JSON output: `{firstLine, lastLine}` of the plan text it read — both being the first and last non-empty trimmed lines — computed the same way `validate-plan` will recompute it from the stored plan. `validate-plan` recomputes the fingerprint and refuses the cycle as a `parse` failure if the values disagree, so the persisted cycle can only describe a plan the reviewer provably read. The fingerprint catches the "reviewer was passed a different path" failure mode; it does not catch the reviewer `read`ing the file but scoring something else. The planner still has to pass the correct path.

Deliberately absent: `lineCount`. Counting raw lines is exactly the off-by-one (trailing newline, blank lines) an LLM is likely to get slightly wrong, and a false-positive mismatch costs a full re-review cycle. If a stronger middle-document anchor is needed later (surgical middle-only edits), add a known sentinel line rather than a fragile line index.

On a successful `finalize-plan`, the runtime removes `.gpd/candidate-plans/` entirely, so no junk is ever left behind. `store-candidate-plan` recreates the directory on the next invocation. On finalize failure the files are retained so you can inspect what the reviewer actually saw.

### Recovery on parse / aborted / stopped / error cycles

When `validate-plan` persists a failed cycle (`status` is `parse`, `aborted`, `stopped`, or `error`), the tool response includes a recovery hint. Follow it: rerun `plan-reviewer` once against the same candidate plan, then call `validate-plan` again with the same `candidatePlanId`. If the second attempt also fails, stop the loop and surface the failed cycle to the user — do not keep retrying silently. If you decide the plan itself is the problem, re-store the plan first and use the new id.

After each plan-reviewer run, call:

```text
validate-plan({
  candidatePlanId: "<id from store-candidate-plan>",
  planningContext: "<planning context JSON string>",
  reviewOutput: "<full raw plan-reviewer output>"
})
```

If the review subagent failed or was aborted, still persist that failed review cycle:

```text
validate-plan({
  candidatePlanId: "<id from store-candidate-plan>",
  reviewOutput: "<raw failure output>",
  reviewStatus: "aborted" // or "stopped" | "error"
})
```

- The review must stay scoped to the stated objective and constraints.
- If the persisted review cycle has **blockers**, revise the candidate plan to address blockers and rerun `plan-reviewer`, then `validate-plan` again. Repeat until the latest persisted review cycle has **no blockers**.
- If the latest persisted review cycle has **warnings** but no blockers, stop the automatic review loop and ask the user whether to:
  - revise the plan to address warnings and rerun review,
  - accept the warnings and finalize by calling `finalize-plan` with `acceptWarnings: true`,
  - or discuss specific warnings first.
- Do not automatically rerun review for warnings.
- Do not rerun review for nitpicks unless the user explicitly asks.
- Blockers can never be accepted; if any blocker remains, revise the plan and rerun review.

> NOTE: there is no enforced cap on review iterations today. If the same blocker survives multiple revise→rerun cycles, the loop is not converging and the planner should stop, surface the persisted blocker history, and ask the user how to proceed. This is a soft guard only; the runtime does not refuse to persist additional cycles.

Only after the latest `validate-plan` result has **no blockers**, and any remaining warnings have been explicitly accepted by the user (or resolved in a later review), call:

```text
finalize-plan({
  markdown: "<exact final PLANS.md markdown>"
})
```

If warnings were accepted, pass `acceptWarnings: true` so the tool records them in the finalized entry:

```text
finalize-plan({
  markdown: "<exact final PLANS.md markdown>",
  acceptWarnings: true
})
```

After a clean review, pass that exact reviewed markdown directly to `finalize-plan` with no renames, heading changes, reformatting, or content edits.
If the markdown changes after a clean review, rerun `plan-reviewer` and `validate-plan` before finalizing.

`PLANS.md` is the only artifact for this workflow.

## Do not

- call `write` directly during planning
- create extra planning files
