1. .planning/PROJECT.md

Project identity and high-level description.

Purpose:
- define what the project is
- capture the overall mission
- give future planning some anchor context

Think:

│ “What is this repo/product supposed to be?”

──────────────────────────────────────────────────────────────────────────────

2. .planning/REQUIREMENTS.md

List of tracked requirements.

Purpose:
- capture the things the project needs to satisfy
- let plans reference requirement IDs like REQ-01
- later let completion mark requirements done

Think:

│ “What must eventually be true?”

──────────────────────────────────────────────────────────────────────────────

3. .planning/ROADMAP.md

List of phases.

Purpose:
- define the project in chunks/phases
- give each phase a name and goal
- track progress phase by phase

Think:

│ “What are the major slices of work?”

In current gsd-lite, planning is phase-oriented, so this file is central.

──────────────────────────────────────────────────────────────────────────────

4. .planning/STATE.md

Current execution/planning state.

Purpose:
- track what phase is active
- track status/progress
- store lightweight current-state info

Think:

│ “Where are we right now?”

──────────────────────────────────────────────────────────────────────────────

5. .planning/phases/

Container for phase-specific files.

Later this will contain things like:

```text
  .planning/phases/01-foundation/
    01-CONTEXT.md
    01-01-PLAN.md
    01-01-SUMMARY.md
```

Purpose:
- isolate planning/execution artifacts per phase

Think:

│ “All detailed work for phase 1 lives here.”

──────────────────────────────────────────────────────────────────────────────
