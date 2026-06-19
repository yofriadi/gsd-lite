# Planner spec

## Purpose

This document defines how the future `gsd` planner should behave.

It is a deeper behavioral/design spec.
It should support `HANDOFF.md`, not compete with it.

Use this document for:

- planner behavior
- questioning model
- decision model
- stopping rules
- plan quality expectations

Use `HANDOFF.md` for:

- current repo direction
- current priorities
- next implementation steps
- migration/rebuild plan

## Product meaning

The planner is not for deciding **what** the user should care about.
The user already knows what they want to work on.

The planner exists to help determine:

- how the work should be built
- what boundaries matter
- what tradeoffs must be resolved
- what order the work should happen in
- what verification makes the plan credible

## Public meaning

- `gsd plan` = help me figure out how to do this work well enough to produce a credible plan
- `gsd plan recheck` = challenge the draft and force weak spots into the open

## Product principles

1. Ask for the problem first.
2. Inspect before asking obvious questions.
3. Ask only about intent, tradeoffs, constraints, and missing external context.
4. Resolve decisions in dependency order.
5. Prefer the smallest useful credible slice.
6. Stop only when ambiguity is resolved, deferred, or explicitly accepted.
7. Recheck every draft before treating it as ready.

## Planning session lifecycle

### 0. Capture the problem neutrally

First prompt:
- `What needs to be solved?`

Do not anchor the opening on:
- roadmap wording
- current phase wording
- current slice wording
- internal artifact structure

Then infer at least:
- planning scope: strategic / feature / tactical
- planning focus: workflow / artifact / CLI / state / verification / implementation

### 1. Load workspace context

Read when available:
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `.planning/STATE.md`
- current phase context
- existing plan/summary artifacts

Goals:
- identify current planning target
- identify already-open work
- identify already-decided constraints
- identify whether the workspace is only starter scaffolding

### 2. Repo reconnaissance

Before asking many questions, inspect the repo.

Recon should summarize:
- current workflow model
- current artifact model
- current command surface
- likely affected files
- contradictions between current behavior and the stated problem
- unresolved design decisions

The exact files inspected will change with the implementation language/runtime.
The principle matters more than the specific file list.

### 3. Build a decision graph

The planner should build a dependency-ordered decision graph.

Example top-level branches:

1. Workflow model
   - what is user-facing: current work, phase, plan, milestone?
   - what does `plan` mean?
   - what does `complete` mean?
2. Artifact model
   - what is the main planning artifact?
   - are plans user-visible or mostly internal?
   - what summaries / decision logs exist?
3. CLI model
   - which commands are public?
   - which are internal?
   - what naming matches the user mental model?
4. State model
   - what is explicit state?
   - what is derived state?
   - how is current work selected?
5. Verification model
   - what proves planning is ready?
   - what proves execution is complete?
6. Implementation model
   - what subsystem or seam matters first?
   - what boundary keeps the slice small?
   - what risk must be reduced early?

Rules:
- parent decisions first
- child decisions only after parent decisions are resolved
- each node ends as one of:
  - resolved by repo
  - resolved by user
  - deferred
  - irrelevant

### 4. Interview loop

For each unresolved node:

1. try to answer from repo evidence
2. if still unresolved, ask one focused question
3. record answer and rationale
4. detect contradictions
5. unlock dependent questions

Question quality bar:
- concrete
- high leverage
- based on repo evidence
- one decision at a time

Bad questions:
- generic schema filling
- asking for files the repo can already suggest
- asking for task counts before workflow shape is settled
- pretending roadmap boilerplate is user intent

### 5. Contradiction handling

If answers conflict, stop and resolve.

Examples:
- “plans should be hidden” vs “I want to manually choose plan 2”
- “phase completion is explicit” vs “plans must each be manually closed”
- “keep this slice minimal” vs “also include adjacent cleanup and refactor work”

Behavior:
- surface both statements
- explain why they conflict
- ask which rule wins
- record the winner explicitly

### 6. Shared-understanding checkpoint

Before writing a plan, show:
- problem
- proposed plan outcome
- decisions made
- constraints
- likely touched surfaces
- open risks
- deferred items
- proposed smallest useful slice

The user confirms or corrects this summary.

### 7. Plan synthesis

Generate the implementation plan only after shared understanding is reached.

Plan contents:
- title
- objective
- resolved decisions
- constraints
- likely touched files/areas
- ordered tasks
- verification
- deferred follow-ups

Task generation rules:
- derive tasks from decisions, not generic templates
- bias toward 1-3 tasks
- split oversized work into follow-up plans instead of bloating the current one
- make verification concrete and observable

## Plan checker

`gsd plan recheck` reviews/challenges a draft.

### Input
- default: latest plan in the current planning target
- optional: explicit plan path

### Output
A structured report with:
- blockers
- warnings
- requirement coverage
- task count
- readiness verdict
- suggestions

### Checks

#### Structural blockers
- missing required metadata
- no task blocks
- task missing required fields

#### Scope checks
- too many tasks
- too many touched files/areas
- placeholder surfaces like `TBD`

#### Requirement checks
- no requirement IDs despite applicable requirements existing
- applicable requirements missing from the plan
- obvious requirement/problem mismatch

#### Clarity checks
- vague task names
- vague action text
- vague done conditions
- generic placeholder language

#### Verification checks
- weak verification text
- non-observable verification
- no command/check/output/behavior specified

### Verdict rules
- any blocker => not ready
- warnings only => reviewable but should be tightened
- no issues => ready

## Session state model

Planning should maintain a richer state than raw prompts.

Suggested shape:

```json
{
  "problem": "...",
  "current_target": "...",
  "repo_findings": [],
  "decision_nodes": [],
  "resolved": [],
  "deferred": [],
  "contradictions": [],
  "affected_surfaces": [],
  "candidate_slice": "..."
}
```

This should eventually be persisted, likely under a planning runtime directory.

## Stopping rules

The loop should stop only when:
- the important workflow/design decisions are resolved enough
- the current slice is bounded
- affected surfaces are identified well enough
- verification is concrete enough
- remaining unknowns are explicitly deferred

The loop should not stop merely because enough text was collected.

## Non-goals

- deciding what the user should care about
- autonomous coding without explicit product direction
- turning planning into a schema form
- preserving internal phase/plan language in the primary UX

## Acceptance criteria

Planning is successful when:
- the user can start with a problem statement instead of a phase id
- the planner inspects the repo before asking obvious questions
- questions focus on how, tradeoffs, and constraints rather than schema fields
- contradictions are surfaced instead of silently absorbed
- `gsd plan recheck` challenges weak drafts
- the final plan is smaller, clearer, and more verifiable than a scripted questionnaire would produce
