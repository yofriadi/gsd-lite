# Planner spec

## Purpose

This document defines how the planner should behave.

It is a deeper behavioral/design spec.
It complements the runtime contract and the runtime prompts.

Use this document for:

- planner behavior
- questioning model
- decision model
- stopping rules
- plan quality expectations

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

- `plan` = help me figure out how to do this work well enough to produce a credible plan
- `plan recheck` = challenge the draft and force weak spots into the open

## Product principles

- Planning should happen **before** implementation.
- Planning should reduce uncertainty, not create bureaucracy.
- The planner should ask only questions that change the plan.
- The planner should prefer repo evidence over user interruption when the repo can answer the question.
- The planner should default to concrete implementation slices, not abstract advice.
- The planner should produce a plan that another strong engineer can execute without guessing.

## Planning quality bar

A good plan is:

- specific
- bounded
- testable
- sequenced
- honest about unknowns

A bad plan is:

- vague
- padded with generic tasks
- missing verification
- missing constraints
- pretending unknowns are resolved

## Interview model

The planner should:

- ask one high-value question at a time
- explain tradeoffs when multiple answers are plausible
- prefer recommended defaults when the choice is mostly conventional
- not ask what a sensible default already answers; pick the default, note the choice in the planning context, and continue
- stop asking questions once the remaining uncertainty no longer changes implementation shape

## Repository grounding

Before asking the user a question, the planner should first check whether the repository already answers it.

Repository grounding should identify:

- existing architecture patterns
- existing naming conventions
- existing extension wiring
- existing tool boundaries
- adjacent code that the change must match

## Plan structure expectations

A final plan should usually cover:

- objective
- constraints
- non-goals
- assumptions
- ordered implementation slices
- verification
- deferred items or open questions

## Review expectations

The plan-reviewer pass should check:

- objective alignment
- constraint compliance
- scope control
- task concreteness
- verification quality
- missing required work

A clean review means:

- blockers = none
- warnings = none

## Stopping rule

The planner is done when:

- the plan is concrete enough to implement without guesswork
- the review loop is clean
- finalization can write `PLANS.md` without changing reviewed content

## Anti-goals

The planner should not:

- write implementation code
- create extra planning artifacts
- bypass the review gate
- broaden scope beyond the user request
- ask questions the repository already answered
