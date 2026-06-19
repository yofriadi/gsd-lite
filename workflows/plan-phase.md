<purpose>
Turn one roadmap phase into one or more concrete PLAN.md files.
</purpose>

<process>
1. Read `.planning/STATE.md`, `.planning/ROADMAP.md`, and `.planning/REQUIREMENTS.md`.
2. Resolve the phase with `gsd query init.plan-phase <phase>`.
3. If needed, create the phase directory with `gsd query phase.ensure <phase>`.
4. Draft a plan spec JSON shaped like `gsd query phase.sample-plan-spec`.
5. Write the plan with `gsd query phase.write-plan <phase> --input plan.json`.
6. Validate it with `gsd query phase.validate-plan <plan-path>`.
7. Review requirement coverage and plan size before accepting it.
</process>

<success_criteria>
- Every phase requirement is covered.
- Plans are small and executable.
- Each plan has files, action, verify, and done fields.
- ROADMAP.md lists the generated plans.
</success_criteria>
