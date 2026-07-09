# gsd-lite

Pi-based planning workflow with a hard-gated review/finalization loop.

## Most important docs

- `AGENTS.md`
- `docs/runtime-contract.md`
- `docs/planner-spec.md`
- `prompts/planner-starter.md`

## Status

Current repo status:

- `/plan` starts an interview-driven planning session
- planning uses synchronous `subagent` calls for repo exploration, GitHub research, and `plan-reviewer`
- `validate-plan` persists each review cycle before finalization
- `finalize-plan` is the only path that expands a reviewed plan bundle into `docs/phases/NN-name/NN-CONTEXT.md` + `NN-MM-PLAN.md` and updates the living docs (`docs/REQUIREMENTS.md`/`ROADMAP.md`/`STATE.md`)
- those phase artifacts + living docs are the intended filesystem output of the planning flow

Verification:

```bash
npm run verify
```

## Current limitation

A fully automatic post-turn orchestration flow is still not reliable with the current Pi SDK behavior. `gsd-lite` therefore keeps the planner in the foreground and uses explicit synchronous subagent calls plus hard-gated review/finalization instead of automatic background resume.
