# gsd-lite

`gsd-lite` is now an aggressively stripped planning/builder fork direction for GSD.

## What this repo is now

This repo is currently mostly:

- product direction
- planning specs
- prompt assets
- planning templates
- example artifacts

It is **not** a working runtime right now.
The previous Go implementation was removed so the project can be rebuilt around:

- **TypeScript**
- **Pi SDK**
- a real agent-driven planning experience

## Intended product direction

`gsd-lite` is meant to become a planner + builder for software work:

- help the user figure out **how** the work should be built
- turn that into concrete planning artifacts
- support execution/build flow
- support review

The user already knows what they want to work on.
The product should help determine:

- approach
- boundaries
- sequencing
- tradeoffs
- verification
- execution shape

## Why the old runtime was removed

The old implementation had become too much of a scripted interview.
That was the wrong shape for `gsd plan`.

The next version should feel like a real planning conversation:

- inspect repo first
- infer intent
- ask only high-value follow-ups
- make decisions with the user
- write plan artifacts only after understanding is good enough

## Current repo layout

- `agents/` — agent prompt assets
- `commands/` — command prompt assets
- `workflows/` — workflow prompt assets
- `templates/` — planning artifact templates
- `references/` — supporting reference material
- `docs/` — design/spec documents
- `examples/` — example planning artifacts
- `HANDOFF.md` — current handoff and concrete next-step plan

## Most important docs

- `HANDOFF.md` — current direction and concrete next steps
- `docs/planner-spec.md` — planning behavior/spec target

## Current direction

The rebuild direction is:

- **TypeScript runtime**
- **Node** as the runtime environment
- **Pi SDK** as the planning runtime
- no more fake planner logic hardcoded as a CLI wizard

## Planned architecture

### Pi SDK side
Responsible for:

- planning conversation
- repo-aware questioning
- intent inference
- decision tracking
- contradiction handling
- planning orchestration

### gsd-lite side
Responsible for:

- planning artifact formats
- templates
- product semantics
- deterministic planner/builder behavior once reimplemented

## Status

Current repo status:

- useful as a stripped spec/assets base
- not yet rebuilt as the new TS implementation

## Next step

Read:

1. `HANDOFF.md`
2. `docs/planning-v2.md`

Then rebuild the runtime around Pi SDK in TypeScript.
