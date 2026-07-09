import assert from 'node:assert';
import { isAbsolute } from 'node:path';
import { test } from 'node:test';

import {
  allocatePlanId,
  parsePlanDoc,
  parseRequirementsDoc,
  parseRoadmapDoc,
  parseStateDoc,
  serializePlanDoc,
  serializeRequirementsBlock,
  serializeRoadmapBlock,
  serializeStateBlock,
} from './doc-parse.js';
import { ParseError } from './parse.js';
import { readTemplate, templatePath } from './templates.js';
import type {
  PlanDoc,
  RequirementsDoc,
  RoadmapDoc,
  StateLedger,
} from './types.js';

function fencedJson(value: unknown): string {
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

test('STATE: populated ledger round-trips through serialize/parse', () => {
  const ledger: StateLedger = {
    pointer: '02-01',
    plans: [
      { id: '01-01', phase: '01', status: 'built' },
      { id: '02-01', phase: '02', status: 'pending' },
      { id: '02-02', phase: '02', status: 'planned' },
    ],
  };

  assert.deepStrictEqual(parseStateDoc(serializeStateBlock(ledger)), ledger);
});

test('STATE: empty ledger accepts null pointer and round-trips', () => {
  const ledger: StateLedger = { pointer: null, plans: [] };

  assert.deepStrictEqual(parseStateDoc(serializeStateBlock(ledger)), ledger);
});

test('STATE: rejects empty-string pointer and invalid status', () => {
  assert.throws(
    () => parseStateDoc(fencedJson({ pointer: '', plans: [] })),
    ParseError,
  );
  assert.throws(
    () =>
      parseStateDoc(
        fencedJson({
          pointer: null,
          plans: [{ id: '01-01', phase: '01', status: 'done' }],
        }),
      ),
    ParseError,
  );
});

test('ROADMAP: populated roadmap round-trips through serialize/parse', () => {
  const roadmap: RoadmapDoc = {
    phases: [
      {
        id: '01',
        name: 'Foundation',
        reqIds: ['REQ-01', 'REQ-02'],
        plans: ['01-01', '01-02'],
      },
      { id: '02', name: 'Build', reqIds: ['REQ-03'], plans: ['02-01'] },
    ],
  };

  assert.deepStrictEqual(
    parseRoadmapDoc(serializeRoadmapBlock(roadmap)),
    roadmap,
  );
});

test('ROADMAP: empty roadmap round-trips through serialize/parse', () => {
  const roadmap: RoadmapDoc = { phases: [] };

  assert.deepStrictEqual(
    parseRoadmapDoc(serializeRoadmapBlock(roadmap)),
    roadmap,
  );
});

test('REQUIREMENTS: bare and fully satisfied rows round-trip', () => {
  const requirements: RequirementsDoc = {
    requirements: [
      { id: 'REQ-01', text: 'Support a bare requirement row.' },
      {
        id: 'REQ-02',
        text: 'Record closure evidence.',
        satisfiedBy: '01-01',
        summary: 'Implemented and documented closure evidence.',
        validatedBy: 'code-reviewer',
        verify: { command: 'npm run verify', ok: true },
        evidence: 'git diff 123..456',
      },
      {
        id: 'REQ-03',
        text: 'Allow skipped verification to be explicit.',
        verify: { command: null, ok: true },
      },
    ],
  };

  const reparsed = parseRequirementsDoc(
    serializeRequirementsBlock(requirements),
  );
  assert.deepStrictEqual(reparsed, requirements);
  assert.deepStrictEqual(
    reparsed.requirements[1],
    requirements.requirements[1],
  );
  assert.strictEqual(reparsed.requirements[2]?.verify?.command, null);
});

test('REQUIREMENTS: rejects invalid validator', () => {
  assert.throws(
    () =>
      parseRequirementsDoc(
        fencedJson({
          requirements: [
            {
              id: 'REQ-01',
              text: 'bad validator',
              validatedBy: 'human-reviewer',
            },
          ],
        }),
      ),
    ParseError,
  );
});

test('PLAN: slices, req brackets, interfaces, and verify command round-trip', () => {
  const plan: PlanDoc = {
    id: '01-02',
    phase: '01',
    verify: 'npm run verify',
    outOfScope: ['docs/generated/**', 'vendor/**'],
    slices: [
      {
        n: 1,
        title: 'Add parser model',
        reqIds: ['REQ-01', 'REQ-02'],
        consumes: ['templates/STATE.md'],
        produces: ['src/doc-parse.ts', 'src/types.ts'],
      },
      {
        n: 2,
        title: 'Wire readers',
        reqIds: [],
        consumes: [],
        produces: [],
      },
    ],
  };

  const reparsed = parsePlanDoc(serializePlanDoc(plan));
  assert.deepStrictEqual(reparsed, plan);
  assert.deepStrictEqual(reparsed.slices[0]?.reqIds, ['REQ-01', 'REQ-02']);
  assert.deepStrictEqual(reparsed.slices[1]?.reqIds, []);
  assert.deepStrictEqual(reparsed.slices[1]?.consumes, []);
  assert.deepStrictEqual(reparsed.slices[1]?.produces, []);
});

test('PLAN: literal verify none and _none_ empty lists round-trip to empty arrays', () => {
  const text = [
    fencedJson({ id: '02-01', phase: '02', verify: 'none' }),
    '',
    '# Plan 02-01',
    '',
    '## Out of Scope',
    '',
    '_none_',
    '',
    '### Slice 1: No external requirements',
    '',
    '#### Consumes',
    '',
    '_none_',
    '',
    '#### Produces',
    '',
    '_none_',
  ].join('\n');

  const parsed = parsePlanDoc(text);
  assert.strictEqual(parsed.verify, 'none');
  assert.deepStrictEqual(parsed.outOfScope, []);
  assert.deepStrictEqual(parsed.slices[0]?.reqIds, []);
  assert.deepStrictEqual(parsed.slices[0]?.consumes, []);
  assert.deepStrictEqual(parsed.slices[0]?.produces, []);
  assert.deepStrictEqual(parsePlanDoc(serializePlanDoc(parsed)), parsed);
});

test('PLAN: absent verify metadata stays undefined and serializes absent', () => {
  const text = [
    fencedJson({ id: '03-01', phase: '03' }),
    '',
    '# Plan 03-01',
    '',
    '## Out of Scope',
    '',
    '_none_',
    '',
    '### Slice 1: Use project default verify',
    '',
    '#### Consumes',
    '',
    '_none_',
    '',
    '#### Produces',
    '',
    '- src/default-verify.ts',
  ].join('\n');

  const parsed = parsePlanDoc(text);
  assert.strictEqual(parsed.verify, undefined);

  const serialized = serializePlanDoc(parsed);
  assert.ok(!serialized.includes('"verify"'));
  assert.deepStrictEqual(parsePlanDoc(serialized), parsed);
});

test('PLAN: literal none bullet items round-trip without colliding with empty marker', () => {
  const plan: PlanDoc = {
    id: '04-01',
    phase: '04',
    verify: 'npm run verify',
    outOfScope: ['none'],
    slices: [
      {
        n: 1,
        title: 'Preserve literal none values',
        reqIds: [],
        consumes: ['none'],
        produces: [],
      },
    ],
  };

  const serialized = serializePlanDoc(plan);
  assert.ok(serialized.includes('- none'));
  assert.ok(serialized.includes('_none_'));
  assert.deepStrictEqual(parsePlanDoc(serialized), plan);
});

test('PLAN: missing required sections throw ParseError', () => {
  assert.throws(
    () =>
      parsePlanDoc(
        [
          fencedJson({ id: '05-01', phase: '05', verify: 'npm run verify' }),
          '',
          '# Plan 05-01',
          '',
          '### Slice 1: Missing out of scope',
          '',
          '#### Consumes',
          '',
          '_none_',
          '',
          '#### Produces',
          '',
          '_none_',
        ].join('\n'),
      ),
    ParseError,
  );
  assert.throws(
    () =>
      parsePlanDoc(
        [
          fencedJson({ id: '05-02', phase: '05', verify: 'npm run verify' }),
          '',
          '# Plan 05-02',
          '',
          '## Out of Scope',
          '',
          '_none_',
          '',
          '### Slice 1: Missing consumes',
          '',
          '#### Produces',
          '',
          '_none_',
        ].join('\n'),
      ),
    ParseError,
  );
  assert.throws(
    () =>
      parsePlanDoc(
        [
          fencedJson({ id: '05-03', phase: '05', verify: 'npm run verify' }),
          '',
          '# Plan 05-03',
          '',
          '## Out of Scope',
          '',
          '_none_',
          '',
          '### Slice 1: Missing produces',
          '',
          '#### Consumes',
          '',
          '_none_',
        ].join('\n'),
      ),
    ParseError,
  );
});

test('allocatePlanId: allocates sequential ids for existing and new phases', () => {
  assert.strictEqual(
    allocatePlanId(['01-01', '01-02', '02-01'], {
      kind: 'existing-phase',
      phase: '01',
    }),
    '01-03',
  );
  assert.strictEqual(
    allocatePlanId(['01-01'], { kind: 'existing-phase', phase: '03' }),
    '03-01',
  );
  assert.strictEqual(
    allocatePlanId(['01-01', '09-04'], { kind: 'new-phase' }),
    '10-01',
  );
  assert.strictEqual(allocatePlanId([], { kind: 'new-phase' }), '01-01');
  assert.strictEqual(
    allocatePlanId(['01-01'], { kind: 'new-phase' }, ['01', '03']),
    '04-01',
  );
});

test('templates: machine-readable templates are structurally valid', async () => {
  assert.deepStrictEqual(parseStateDoc(await readTemplate('STATE')), {
    pointer: null,
    plans: [],
  });
  assert.deepStrictEqual(parseRoadmapDoc(await readTemplate('ROADMAP')), {
    phases: [],
  });
  assert.deepStrictEqual(
    parseRequirementsDoc(await readTemplate('REQUIREMENTS')),
    {
      requirements: [],
    },
  );

  const plan = parsePlanDoc(await readTemplate('PLAN'));
  assert.strictEqual(plan.id, 'NN-MM');
  assert.strictEqual(plan.phase, 'NN');
  assert.strictEqual(plan.verify, 'npm run verify');
  assert.ok(plan.slices.length >= 1);
});

test('templates: prose templates resolve to non-empty strings', async () => {
  for (const name of ['PROJECT', 'CONTEXT', 'SUMMARY'] as const) {
    assert.ok(isAbsolute(templatePath(name)));
    assert.ok((await readTemplate(name)).trim().length > 0);
  }
});
