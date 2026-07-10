## Prerequisite

You MUST load these,

Skills:
- `karpathy-guidelines` — reduce LLM mistakes
- `code-review-and-quality` — baked into the `code-reviewer` rubric; you do not invoke it separately

Subagent types you may invoke via the `subagent` tool:
- `code-reviewer` — produces the review JSON for one candidate change
- `codebase-explorer` — repo research (current cwd)
- `doc-lookup` — external web/prose research (API docs, changelogs, RFCs, specs, articles)

This branch turn is TOP-LEVEL, so it CAN spawn `code-reviewer` directly. Subagents run with `inherit_context: false`, so only their returned results enter this turn. Pass every fact they need in the assignment prompt; do not assume they can see this turn's hidden context.

Invoke subagents in foreground mode and wait for the result when targeted research or review would unblock the slice.

```text
subagent({
  subagent_type: "<subagents>",
  description: "<3-5 word task summary>",
  prompt: "<specific assignment>",
  run_in_background: false,
})
```

### Subagent rules

- Do not spawn background subagents.
- Use `codebase-explorer` for repo research when direct inspection would sprawl.
- Use `doc-lookup` only for external API/spec/version facts needed by this slice.
- Do not duplicate a subagent task yourself after it finishes; synthesize in this turn.
- If the subagent tool reports an unknown agent type, stop and report that `code-reviewer` is unavailable in the current Pi agent directory.

## Runtime inputs

The `/build` orchestrator should provide the target plan context, including:

- `planId` (`NN-MM`)
- `sliceN`
- repo-relative `NN-MM-PLAN.md` path
- repo-relative `NN-CONTEXT.md` path
- slice goal and covered REQ ids, or enough information to locate them in the plan

If any required input is missing, stop and report the missing input. Do not guess the plan or slice.

## Heading-map bounded read

Before implementing, build a heading map of `NN-MM-PLAN.md` and `NN-CONTEXT.md`. Do not read either whole document.

Scan only headings with `^#{1,3} ` and every `### Slice <N>` unit, recording line numbers. Then read only bounded sections this slice needs:

- this slice's own `### Slice <N>` section
- that slice's `#### Consumes` and `#### Produces` interface blocks
- the plan-level `## Out of Scope` block
- the covered REQ ids for this slice
- the pinned plan-level `verify:` command
- any small bounded `NN-CONTEXT.md` section directly referenced by the slice

Use line ranges from the heading map. If a needed section is missing, stop and report the missing heading. This matters because plan docs grow; context discipline is part of correctness.

## Slice scope

Implement ONLY this slice.

Respect `#### Consumes`: use only the symbols, types, artifacts, or behavior the slice says are available from earlier slices. Respect `#### Produces`: leave the symbols, types, artifacts, or behavior that later slices rely on.

Treat the plan's `## Out of Scope` block as a hard boundary. Any diff touching a path listed there is a blocker to resolve before validation. Never modify out-of-scope paths.

Use `write`, `edit`, and `bash` for SOURCE only. Protected docs are OFF LIMITS during `/build`:

- `docs/PROJECT.md`
- `docs/REQUIREMENTS.md`
- `docs/ROADMAP.md`
- `docs/STATE.md`
- `docs/phases/**/NN-MM-SUMMARY.md`

Those docs are written only by finalize tools. A permission guard may block direct writes; do not try to bypass it.

## Implement

Work surgically. Match existing style. Do not bundle cleanup or refactors unrelated to this slice. If the slice needs repo research, prefer a focused `codebase-explorer` prompt over sprawling reads.

Keep a touched-file list as you work. Keep it repo-relative. Do not include protected docs. If git is unavailable, this list is what the tools use.

Before review, write a concise change-summary doc in memory with:

- plan id and slice number
- slice goal
- covered REQ ids
- touched files
- what changed and why
- verification command and exit result
- per-REQ audit notes
- any known warnings or follow-ups

Do not store it until after the fresh verify run.

## Verify before storing

Run the resolved verify command via `bash` as the LAST step before `store-candidate-change`, and capture `{command, exitCode}` from the actual run.

The command is the plan's pinned `verify:` field, for example `npm run verify`. If the plan pins `verify: none`, skip the command and record:

- `verifyCommand = null`
- `verifyExitCode = null`
- `verify.ok = true`

Tell the reviewer that the absence of a mechanical verify is warning-worthy. Never silently skip a missing verify command; if the plan does not pin either a command or `none`, stop and report the plan defect.

Verification-before-completion rule: before claiming the slice done, run the verify command FRESH and read its ACTUAL exit result. Avoid "should", "seems", or "probably". State only what the exit code proves.

## Store, review, validate

The change-summary doc is the single source of truth for the review cycle. Store it, then reference it by path. The reviewer reads it from disk, and `validate-change` persists the same stored bytes. Never re-pass the change summary inline as a second copy.

```text
store-candidate-change({
  change: "<candidate change-summary markdown>",
  planId: "<NN-MM>",
  sliceN: <slice number>,
  touchedFiles: ["<repo-relative path>"]
})
// returns: { id, path, iteration }
```

When git is available, the tool also writes `.gpd/candidate-changes/<id>.diff`. Use that repo-relative path as `diffPath` if it exists; otherwise pass `diffPath: null` and explain that no diff artifact is available.

Then spawn `code-reviewer`. You MUST pass all 6 required inputs:

```text
subagent({
  subagent_type: "code-reviewer",
  description: "review slice change",
  prompt: """
Review this candidate change for one /build slice.

sliceGoal: <one sentence or short paragraph>
reqIds: ["REQ-..."]
outOfScope: ["<paths/modules from ## Out of Scope>"]
verify: { "command": <string|null>, "exitCode": <number|null>, "ok": <boolean> }
changeSummaryPath: <path returned by store-candidate-change>
diffPath: <.gpd/candidate-changes/<id>.diff or null>

Read changeSummaryPath from disk. If diffPath is non-null, read it too. Confirm claims against the diff and source files. Include reviewReadFingerprint: {firstLine,lastLine} for the change-summary doc you read, using the first and last non-empty trimmed lines. Return only the required fenced review JSON.
""",
  run_in_background: false,
})
```

`reviewReadFingerprint` proves the reviewer read the stored change-summary doc. `validate-change` recomputes the first/last non-empty trimmed-line fingerprint from the stored bytes and refuses the cycle as `parse` if it disagrees. Do not ask for `lineCount`; it is too fragile.

After the reviewer returns, pass its raw output through unchanged:

```text
validate-change({
  candidateChangeId: "<id from store-candidate-change>",
  planId: "<NN-MM>",
  sliceN: <slice number>,
  reviewOutput: "<full raw code-reviewer output>",
  verifyCommand: <string|null>,
  verifyExitCode: <number|null>,
  outOfScope: ["<paths/modules from ## Out of Scope>"],
  touchedFiles: ["<repo-relative path>"]
})
```

`validate-change` does NOT review. It parses and persists the `change-review-cycle`, recomputes the fingerprint, mechanically injects an out-of-scope blocker when a touched file matches `outOfScope`, and forces the cycle to needs-revision when `verify.ok` is false. Do not hand-write or reformat review JSON.

If the review subagent failed, was aborted, stopped, or errored, still persist the failed cycle:

```text
validate-change({
  candidateChangeId: "<id from store-candidate-change>",
  planId: "<NN-MM>",
  sliceN: <slice number>,
  reviewOutput: "<raw failure output>",
  reviewStatus: "aborted", // or "stopped" | "error"
  verifyCommand: <string|null>,
  verifyExitCode: <number|null>,
  outOfScope: ["<paths/modules from ## Out of Scope>"],
  touchedFiles: ["<repo-relative path>"]
})
```

Follow the tool's recovery hint. Rerun `code-reviewer` once against the same stored candidate change, then call `validate-change` again. If the second attempt also fails, stop and surface the failed cycle to the user. If the tool says the stored candidate is stale or mismatched, re-store the same candidate change first and retry once.

## Revise loop

A slice passes only when BOTH are true:

- `verify.ok` is true
- latest persisted review has `blockers.length === 0`

Warnings may remain. The plan-level `acceptWarnings` decision is deferred to `finalize-build`; do not stop the slice loop only because warnings exist.

If the latest cycle has blockers, including `verify.ok=false`, revise and re-review. Hard cap: 3 implement → verify+review → revise cycles total for this slice.

On cycles 2 and 3, work from the latest cycle's outstanding blockers as a compact findings summary. Do NOT replay the full prior review history into your working context. Persisted cycles remain the source of truth; this compaction only keeps the branch turn focused.

After the 3rd cycle, if blockers remain, STOP without claiming the slice complete. Do not loop unattended. The orchestrator will read the blockers-carrying latest cycle, set `execution-context.status = blocked`, and surface the slice to the user.

## Per-REQ audit

Before claiming the slice complete, audit EACH covered REQ id individually.

For every REQ id, confirm the change actually satisfies it, cite the touched file(s) or tests that provide evidence, and note any warning that remains. Do not assert completion in aggregate.

If any REQ cannot be tied to the implemented change, treat it as a blocker and revise before the next review cycle.

## Completion report

When the latest persisted cycle has no blockers and `verify.ok=true`, report compactly:

- plan id and slice number
- candidate change id and iteration
- verify command and exit code (`null` only for explicit `verify: none`)
- blocker count and warning count from the latest cycle
- touched files
- per-REQ audit result

Do not call finalize tools. The orchestrator owns finalization after all slices are clean or warnings-only.

## Do not

- Do NOT call finalize tools yourself.
- Do NOT write to protected docs.
- Do NOT hand-write review JSON.
- Do NOT modify out-of-scope paths.
- Do NOT exceed the 3-cycle cap.
- Do NOT claim completion without a fresh passing verify run.
- Do NOT claim a REQ is satisfied without auditing it individually.
- Do NOT continue after `code-reviewer` is unavailable; stop and report it.
