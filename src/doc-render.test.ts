import assert from 'node:assert';
import { test } from 'node:test';

import { renderAttemptsTable, renderContextSections } from './doc-render.js';
import type {
  GsdChangeReviewCycle,
  GsdReviewResult,
  PlanningContext,
} from './types.js';

function cleanReview(summary = 'clean'): GsdReviewResult {
  return { blockers: [], warnings: [], nitpicks: [], summary };
}

test('renderContextSections: maps context fields into rendered sections', () => {
  const context: PlanningContext = {
    objective: 'ship phase 1',
    constraints: ['keep parser data as json blocks'],
    nonGoals: ['implement build flow'],
    assumptions: ['templates live under package root'],
    deferredItems: ['build finalization details'],
    repoFindings: ['src/parse.ts exposes ParseError'],
  };

  const rendered = renderContextSections(context);
  assert.ok(rendered.includes('## Findings'));
  assert.ok(rendered.includes('## Decisions'));
  assert.ok(rendered.includes('## Deferred Unknowns'));
  assert.ok(rendered.includes('- src/parse.ts exposes ParseError'));
  assert.ok(rendered.includes('- keep parser data as json blocks'));
  assert.ok(rendered.includes('- templates live under package root'));
  assert.ok(rendered.includes('- build finalization details'));
});

test('renderContextSections: empty fields render present sections with _none_ bullets', () => {
  const rendered = renderContextSections({
    objective: 'ship phase 1',
    constraints: [],
    nonGoals: [],
    assumptions: [],
    deferredItems: [],
    repoFindings: [],
  });

  assert.ok(rendered.includes('## Findings\n\n- _none_'));
  assert.ok(rendered.includes('## Decisions\n\n- _none_'));
  assert.ok(rendered.includes('## Deferred Unknowns\n\n- _none_'));
});

test('renderAttemptsTable: empty cycles keep section, table header, and no-records note', () => {
  const rendered = renderAttemptsTable([]);

  assert.ok(rendered.includes('## Attempts / Blockers'));
  assert.ok(
    rendered.includes(
      '| Cycle | Slice | Blockers | Verify | Revision | Result |',
    ),
  );
  assert.ok(rendered.includes('| --- | --- | --- | --- | --- | --- |'));
  assert.match(rendered.toLowerCase(), /no .* recorded/);
});

test('renderAttemptsTable: renders pass, fail, none, rows, and per-slice revisions', () => {
  const cycles: GsdChangeReviewCycle[] = [
    {
      iteration: 1,
      planId: '01-01',
      sliceN: 1,
      ok: true,
      candidateChange: 'slice 1 change v1',
      raw: '{}',
      review: cleanReview('slice 1 clean'),
      verify: { command: 'npm run verify', exitCode: 0, ok: true },
      status: 'clean',
    },
    {
      iteration: 2,
      planId: '01-01',
      sliceN: 1,
      ok: false,
      candidateChange: 'slice 1 change v2',
      raw: 'verify failed',
      verify: { command: 'npm run verify', exitCode: 2, ok: false },
      status: 'error',
      message: 'verify failed',
    },
    {
      iteration: 3,
      planId: '01-01',
      sliceN: 2,
      ok: true,
      candidateChange: 'slice 2 change',
      raw: '{}',
      review: cleanReview('slice 2 clean'),
      verify: { command: null, exitCode: null, ok: true },
      status: 'clean',
    },
  ];

  const rendered = renderAttemptsTable(cycles);
  const rows = rendered.split('\n').filter((line) => /^\| \d+ \|/.test(line));

  assert.strictEqual(rows.length, cycles.length);
  assert.strictEqual(rows[0], '| 1 | 1 | 0 | pass | 1 | clean |');
  assert.strictEqual(rows[1], '| 2 | 1 | error | fail(exit 2) | 2 | error |');
  assert.strictEqual(rows[2], '| 3 | 2 | 0 | none | 1 | clean |');
});
