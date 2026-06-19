# HANDOFF

## Brief summary of the original goal

`gsd-lite` is meant to be an aggressive minimal fork of `gsd-core` focused on the useful core of the product:

- planning
- execution / building
- code review
- help

The intended product direction is **planner + builder** for software work:

- help the user figure out how the work should be built
- turn that into concrete work artifacts
- help execute/build the work
- help review the result

The user already knows what they want to work on.
The planner should help determine:

- approach
- boundaries
- sequencing
- tradeoffs
- verification
- execution shape

---

## Current repo state

This repo is now intentionally stripped down.

It currently contains mostly:

- product direction
- planning specs
- prompt assets
- templates
- references
- example artifacts

This repo now a clean base for building `gsd-lite` in:

- TypeScript
- Node
- Pi SDK

### What remains important in the repo

- `HANDOFF.md` — main entrypoint for future work
- `docs/planner-spec.md` — deeper planner behavior spec
- `templates/` — planning artifact templates
- `commands/`, `workflows/`, `agents/` — prompt assets
- `references/` — supporting material
- `examples/` — example planning artifacts

---

## Main product correction

The earlier `gsd plan` direction was too much like a scripted interview.
That is now considered the wrong shape.

The desired planner behavior is:

- real planning conversation
- repo-aware questioning
- intent inference
- high-value follow-ups only
- decision tracking
- contradiction handling
- write artifacts only after understanding is credible

The planner should not feel like a form or wizard.

---

## New architectural direction

## Product split

### Pi SDK runtime side
Use Pi as the real planning runtime.

Responsibilities:

- conversation loop
- repo inspection
- intent inference
- clarification questions
- contradiction repair
- decision tracking
- planning-state persistence
- orchestration for plan synthesis

### `gsd-lite` product side
Rebuild deterministic product behavior in TypeScript.

Responsibilities:

- workspace creation
- planning artifact reads/writes
- roadmap/state/requirements sync
- validation
- recheck
- review/build helper logic later

This means the next implementation should **not** rebuild another scripted planner in code.
It should build a Pi-powered planner runtime with deterministic artifact operations behind it.

---

## Concrete plan: `gsd init` and `gsd plan`

## 1. Rework `gsd init`

### Goal
Make `gsd init` establish neutral planning scaffolding without pretending starter roadmap language already reflects real project intent.

### Required changes

1. Keep `gsd init` deterministic and simple.
2. Make generated templates explicitly provisional.
3. Ensure initial workspace language does **not** bias first planning toward:
   - `Deliver the first working slice`
   - phase-first assumptions
   - roadmap-as-truth assumptions
4. Clarify that initialized artifacts are starter scaffolding, not project understanding.

### Likely file targets

- `templates/project.md`
- `templates/roadmap.md`
- `templates/state.md`
- `README.md`

### Success criteria

- a fresh `gsd init` workspace feels neutral
- initial docs/templates do not over-steer the first planning conversation
- `gsd plan` can treat the workspace as scaffolding, not as already-decided truth

---

## 2. Rebuild `gsd plan`

### Goal
Replace the old scripted planner shape with a Pi SDK-powered planning conversation.

### Required changes

1. Start with:
   - `What needs to be solved?`
2. Let the planner infer what kind of planning this is.
3. Inspect the repo before asking obvious questions.
4. Ask only high-value follow-ups.
5. Persist planning decisions and findings.
6. Write plan artifacts only after shared understanding is good enough.

### Important rule
`gsd plan` should not assume at the start whether the user wants:

- strategic planning
- feature planning
- tactical planning
- roadmap shaping
- first milestone planning
- narrow implementation planning

That should be inferred conversationally.

---

## 3. Build the Pi SDK planning runtime

### Goal
Use Pi's full planning potential instead of hardcoding planner behavior into a CLI wizard.

### Runtime direction
Build around:

- TypeScript
- Node
- Pi SDK

### Responsibilities of the planning runtime

- start and manage planning session
- load repo + `.planning/` context
- expose deterministic backend tools
- stream planning conversation
- maintain decision state
- request clarification only when needed
- emit structured planning result

### Likely implementation pieces

- TypeScript runtime entrypoint
- Pi SDK session/runtime setup
- tool wrappers for deterministic artifact operations
- session/state schema for planning decisions
- final plan synthesis + write/validate/recheck flow

---

## 4. Expose deterministic planning tools

### Goal
Turn current product behavior into stable tool surfaces the planning agent can call.

### Candidate tool surfaces

- get planning context
- infer current target / active work
- list roadmap phases
- inspect existing plans / summaries
- write plan
- validate plan
- recheck plan
- write planning session notes / deferred decisions

### Constraint
Do not let plan-writing logic drift fully into the agent runtime.
The agent should decide; deterministic code should write and validate.

---

## 5. Persist planning session state

### Goal
Planning should leave behind useful machine-readable state, not only the final plan file.

### Store at least

- problem statement
- inferred planning type / mode
- decisions made
- deferred items
- contradictions
- repo findings
- rationale for chosen slice

### Likely location

- `.planning/runtime/`
- or similar dedicated runtime/session directory

---

## 6. Make `gsd plan` feel like a real planning conversation

### Desired UX
The user should feel like they are talking to an intelligent planner, not filling fields.

### Behavioral requirements

- inspect first, ask second
- ask one high-value question at a time
- update beliefs from answers
- branch based on intent
- ask less when repo evidence is enough
- stop only when the plan is genuinely credible

### Anti-goals

- fixed wizard feel
- schema-first prompting
- exposing internal phase/plan structure too early
- using roadmap boilerplate as initial intent

---

## 7. Keep execution/build path aligned with planner-builder goal

### Goal
Planning and building should remain one product, not two disconnected utilities.

### Implication
After `gsd plan` is corrected, next work should connect planning output better to execution/build flow:

- current work selection
- execution commands
- completion semantics
- future builder/executor handoff

This does **not** need to be solved before the planning runtime rewrite, but the architecture should leave room for it.

---

## Concrete implementation sequence

1. **Neutralize `gsd init` scaffolding language**
   - remove over-strong default goal assumptions from templates/docs
2. **Design the Pi SDK planning runtime**
   - choose exact runtime/process shape
   - keep full Pi capability
3. **Define deterministic planning tools**
   - context/read/write/validate/recheck
4. **Replace the old planner shape with a Pi-powered session**
   - first prompt: `What needs to be solved?`
5. **Persist planning session state**
6. **Refine plan synthesis and handoff into execution/build path**

---

## Immediate next step recommended

Do **not** deepen any more scripted planner logic.
That path is abandoned.

Next task should be an architecture/design pass for the:

- TypeScript + Node + Pi SDK planning runtime

That design should answer:

- how the Pi-powered planner is started
- how deterministic tools are exposed
- how planning state is persisted
- how final plan write/validate/recheck is committed back into `gsd-lite`

---

## Files and directories most likely to matter next

- `HANDOFF.md`
- `docs/planner-spec.md`
- `templates/project.md`
- `templates/roadmap.md`
- `templates/state.md`
- `README.md`
- `commands/`
- `workflows/`
- `agents/`
- `references/`
- `examples/`

---

## Bottom line

The main unfinished problem is no longer fixing an old planner implementation.
The main unfinished problem is rebuilding `gsd-lite` as a real Pi SDK-powered planner/builder runtime in TypeScript, while keeping planning artifacts, templates, and product semantics clean and deterministic.
