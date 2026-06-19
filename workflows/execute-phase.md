<purpose>
Execute all incomplete plans in one phase.
</purpose>

<process>
1. Read `.planning/STATE.md` and resolve the phase with `gsd query init.execute-phase <phase>`.
2. Find the next incomplete plan with `gsd query phase.next-plan <phase>`.
3. Read that PLAN.md and execute it.
4. Draft a summary spec JSON shaped like `gsd query phase.sample-summary-spec`.
5. Write the summary with `gsd query phase.write-summary <phase> --input summary.json`.
6. Re-run `gsd query phase-plan-index <phase>` and stop only when no incomplete plans remain.
</process>

<success_criteria>
- Each completed plan has a SUMMARY.
- REQUIREMENTS.md is updated for shipped requirement IDs.
- ROADMAP.md progress is updated.
- STATE.md progress advances.
</success_criteria>
