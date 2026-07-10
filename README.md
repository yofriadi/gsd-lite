# gsd-lite

`gsd-lite` is a Pi package that adds a guarded planning workflow for software projects.

It registers:
- `/init` — scaffold the planning docs for a repo
- `/plan` — run an interview-driven planning session
- `store-candidate-plan` — persist the exact bundle sent for review
- `validate-plan` — persist the latest review cycle
- `finalize-plan` — expand a reviewed bundle into durable docs only after all gates pass

The goal is to keep planning artifacts structured, reviewable, and hard to finalize incorrectly.

## What it writes

`finalize-plan` does **not** write a single top-level `PLANS.md`.
It expands a reviewed plan bundle into:

- `docs/phases/NN-name/NN-CONTEXT.md`
- `docs/phases/NN-name/NN-MM-PLAN.md`
- `docs/REQUIREMENTS.md`
- `docs/ROADMAP.md`
- `docs/STATE.md`

## Installation

### As a Pi package

This repo is published as a Pi extension package via `package.json`:

- `pi.extensions`: `./index.ts`
- `pi.skills`: `./skills`

Install it in the Pi environment you use for a project, then load the package so Pi can register the extension and commands.

### Local development

```bash
yarn install
npm run verify
```

Verification runs:

```bash
npm run typecheck
eslint '**/*.ts'
npm test
prettier --check '**/*.ts'
```

## How to use it

### 1. Initialize planning docs

In a repo opened in Pi:

```text
/init
```

This scaffolds the base planning docs used by the workflow.

### 2. Start a planning session

```text
/plan
```

The planner will:
- interview you for scope and constraints
- explore the repo with subagents
- build a candidate plan bundle
- send that bundle through `plan-reviewer`
- persist the review result with `validate-plan`
- allow `finalize-plan` only when the latest reviewed bundle is eligible

### 3. Finalize only after review

A bundle can be finalized only when:
- the latest persisted review cycle is clean, or warnings were explicitly accepted
- a planning context was captured for that same review cycle
- the finalized markdown matches the reviewed candidate bundle
- structural checks pass

Those structural checks include:
- requirement id resolution
- slice-to-plan requirement mapping
- reverse coverage for claimed requirements
- roadmap requirement references
- valid state pointer
- plan marked `planned`
- valid `NN` phase ids and `NN-MM` plan ids

## Most important docs

- `AGENTS.md`
- `docs/runtime-contract.md`
- `docs/planner-spec.md`
- `prompts/planner-starter.md`

## Status

Current repo status:

- `/plan` starts an interview-driven planning session
- planning uses synchronous `subagent` calls for repo exploration, GitHub research, and `plan-reviewer`
- both review subagents ship in-repo under `.pi/agent/agents/` (`plan-reviewer.md`, `code-reviewer.md`), so no global install is required; project agents override any global agent of the same name and both emit the same review JSON shape (`{blockers,warnings,nitpicks,summary,reviewReadFingerprint}`)
- `validate-plan` persists each review cycle before finalization
- `finalize-plan` is the only path that expands a reviewed plan bundle into `docs/phases/NN-name/NN-CONTEXT.md` + `NN-MM-PLAN.md` and updates the living docs (`docs/REQUIREMENTS.md`/`ROADMAP.md`/`STATE.md`)
- those phase artifacts + living docs are the intended filesystem output of the planning flow

## Current limitation

A fully automatic post-turn orchestration flow is still not reliable with the current Pi SDK behavior. `gsd-lite` therefore keeps the planner in the foreground and uses explicit synchronous subagent calls plus hard-gated review/finalization instead of automatic background resume.
