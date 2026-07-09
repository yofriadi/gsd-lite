import assert from 'node:assert';
import { test } from 'node:test';

import { parsePlanBundle, serializePlanBundle } from './bundle.js';
import { ParseError } from './parse.js';
import type { RequirementsDoc, RoadmapDoc, StateLedger } from './types.js';

function fencedJson(value: unknown): string {
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

const planMarkdown = [
  fencedJson({
    id: '01-01',
    phase: '01',
    reqIds: ['REQ-01'],
    verify: 'npm run verify',
  }),
  '',
  '# Plan 01-01',
  '',
  '## Out of Scope',
  '',
  '- docs/generated/**',
  '',
  '### Slice 1: Add bundle parser [REQ-01]',
  '',
  '#### Consumes',
  '',
  '_none_',
  '',
  '#### Produces',
  '',
  '- src/bundle.ts',
].join('\n');

const requirements: RequirementsDoc = {
  requirements: [{ id: 'REQ-01', text: 'Parse plan bundles.' }],
};
const roadmap: RoadmapDoc = {
  phases: [
    {
      id: '01',
      name: 'Planning Artifacts',
      reqIds: ['REQ-01'],
      plans: ['01-01'],
    },
  ],
};
const state: StateLedger = {
  pointer: '01-01',
  plans: [{ id: '01-01', phase: '01', status: 'planned' }],
};

test('PlanBundle: serialize/parse round-trips model and plan markdown', () => {
  const serialized = serializePlanBundle({
    planMarkdown,
    requirements,
    roadmap,
    state,
  });

  const parsed = parsePlanBundle(serialized);
  assert.strictEqual(parsed.planMarkdown, planMarkdown.trim());
  assert.deepStrictEqual(parsed.requirements, requirements);
  assert.deepStrictEqual(parsed.roadmap, roadmap);
  assert.deepStrictEqual(parsed.state, state);
  assert.deepStrictEqual(parsed.plan, {
    id: '01-01',
    phase: '01',
    reqIds: ['REQ-01'],
    verify: 'npm run verify',
    outOfScope: ['docs/generated/**'],
    slices: [
      {
        n: 1,
        title: 'Add bundle parser',
        reqIds: ['REQ-01'],
        consumes: [],
        produces: ['src/bundle.ts'],
      },
    ],
  });
});

test('PlanBundle: parses sections by exact marker regardless of order', () => {
  const text = [
    '<!-- gpd:section=requirements -->',
    fencedJson(requirements),
    '<!-- gpd:section=plan -->',
    planMarkdown,
    '<!-- gpd:section=state -->',
    fencedJson(state),
    '<!-- gpd:section=roadmap -->',
    fencedJson(roadmap),
  ].join('\n');

  const parsed = parsePlanBundle(text);
  assert.strictEqual(parsed.plan.id, '01-01');
  assert.deepStrictEqual(parsed.requirements, requirements);
  assert.deepStrictEqual(parsed.roadmap, roadmap);
  assert.deepStrictEqual(parsed.state, state);
});

test('PlanBundle: missing or duplicated marker throws ParseError', () => {
  assert.throws(
    () =>
      parsePlanBundle(
        [
          '<!-- gpd:section=plan -->',
          planMarkdown,
          '<!-- gpd:section=requirements -->',
          fencedJson(requirements),
          '<!-- gpd:section=roadmap -->',
          fencedJson(roadmap),
        ].join('\n'),
      ),
    ParseError,
  );

  assert.throws(
    () =>
      parsePlanBundle(
        [
          '<!-- gpd:section=plan -->',
          planMarkdown,
          '<!-- gpd:section=plan -->',
          planMarkdown,
          '<!-- gpd:section=requirements -->',
          fencedJson(requirements),
          '<!-- gpd:section=roadmap -->',
          fencedJson(roadmap),
          '<!-- gpd:section=state -->',
          fencedJson(state),
        ].join('\n'),
      ),
    ParseError,
  );
});
