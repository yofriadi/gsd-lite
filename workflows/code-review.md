<purpose>
Review a diff, a plan, or executed phase output.
</purpose>

<process>
1. For active code review, inspect `gsd query review.current-diff --staged` or `gsd query review.current-diff`.
2. For phase review, inspect `gsd query review.phase <phase>` and read the referenced plans/summaries.
3. Check correctness, coverage, edge cases, simplicity, and drift from requirements.
4. Return actionable findings only, with blockers first.
</process>
