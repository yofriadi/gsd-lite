/**
 * Render derived doc sections from already-persisted data.
 *
 * These are LEGIBLE VIEWS over existing sources of truth, not new authored
 * prose and not new pinned schema fields:
 *   - `renderContextSections` derives NN-CONTEXT.md's `## Findings` /
 *     `## Decisions` / `## Deferred Unknowns` from the pinned planning-context
 *     fields (repoFindings -> Findings; constraints + assumptions -> Decisions;
 *     deferredItems -> Deferred Unknowns).
 *   - `renderAttemptsTable` derives NN-MM-SUMMARY.md's `## Attempts / Blockers`
 *     per-cycle table from the persisted `change-review-cycle` entries.
 *
 * `finalize-plan` and `finalize-build` call these; the persisted entries remain
 * the single source of truth.
 */

import type {
  GsdChangeReviewCycle,
  PlanningContext,
  VerifyResult,
} from './types.js';

function bulletsOrNone(items: readonly string[]): string {
  if (items.length === 0) return '- _none_';
  return items.map((i) => `- ${i}`).join('\n');
}

/**
 * Render the three CONTEXT sections from the pinned planning-context fields.
 * Findings = repoFindings; Decisions = constraints then assumptions;
 * Deferred Unknowns = deferredItems. Empty fields render an `_none_` bullet so
 * the section is present-but-empty rather than missing.
 */
export function renderContextSections(context: PlanningContext): string {
  const decisions = [...context.constraints, ...context.assumptions];
  return [
    '## Findings',
    '',
    bulletsOrNone(context.repoFindings),
    '',
    '## Decisions',
    '',
    bulletsOrNone(decisions),
    '',
    '## Deferred Unknowns',
    '',
    bulletsOrNone(context.deferredItems),
  ].join('\n');
}

function verifyCell(verify: VerifyResult): string {
  if (verify.command === null) return 'none';
  if (verify.ok) return 'pass';
  return `fail(exit ${verify.exitCode ?? '?'})`;
}

/**
 * Escape a value for a markdown table cell: strip newlines and escape pipes so
 * a summary/issue string can never break the table grid.
 */
function cell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Render the `## Attempts / Blockers` section from a plan's change-review
 * cycles. The per-cycle table columns are
 * `| Cycle | Slice | Blockers | Verify | Revision | Result |`:
 *   - Cycle    = global review iteration
 *   - Slice    = slice number
 *   - Blockers = blocker count (or the failure status for a failed cycle)
 *   - Verify   = recorded verify outcome (pass / fail(exit N) / none)
 *   - Revision = 1-based attempt ordinal within that slice
 *   - Result   = cycle status
 * An empty cycle set renders the header row + a "no blockers recorded" note,
 * not a missing section.
 */
export function renderAttemptsTable(
  cycles: readonly GsdChangeReviewCycle[],
): string {
  const header = [
    '## Attempts / Blockers',
    '',
    '| Cycle | Slice | Blockers | Verify | Revision | Result |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  if (cycles.length === 0) {
    return [...header, '', '_No revision cycles recorded._'].join('\n');
  }
  const attemptBySlice = new Map<number, number>();
  const rows = cycles.map((c) => {
    const attempt = (attemptBySlice.get(c.sliceN) ?? 0) + 1;
    attemptBySlice.set(c.sliceN, attempt);
    const blockers = c.ok ? String(c.review.blockers.length) : c.status;
    return `| ${c.iteration} | ${c.sliceN} | ${cell(blockers)} | ${verifyCell(
      c.verify,
    )} | ${attempt} | ${cell(c.status)} |`;
  });
  return [...header, ...rows].join('\n');
}
