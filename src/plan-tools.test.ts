import assert from 'node:assert';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { serializePlanBundle } from './bundle.js';
import {
  parseRequirementsDoc,
  parseRoadmapDoc,
  parseStateDoc,
} from './doc-parse.js';
import {
  planFingerprint,
  toolFinalizePlan,
  toolStoreCandidatePlan,
  toolValidatePlan,
} from './plan-tools.js';
import {
  ENTRY,
  type GsdPlanFinalized,
  type GsdPlanReviewCycle,
  type GsdReviewResult,
  type GsdStoredCandidatePlan,
  type Requirement,
  type RoadmapPhase,
  type StatePlan,
} from './types.js';

const TEST_PLAN_ID = 'plan-test-id';

function reviewJson(review: GsdReviewResult): string {
  return ['```json', JSON.stringify(review, null, 2), '```'].join('\n');
}

function planningContext() {
  return {
    objective: 'build the thing',
    constraints: ['use TypeScript'],
    nonGoals: ['rewrite the world'],
    assumptions: ['pi SDK available'],
    deferredItems: ['execution order'],
    repoFindings: ['uses node:test'],
  };
}

function planningContextJson(): string {
  return JSON.stringify(planningContext());
}

function contextEntry(iteration = 1) {
  return {
    customType: ENTRY.planningContext,
    data: { iteration, ...planningContext() },
  };
}

function storedPlanEntry(
  id: string,
  plan: string,
  iteration = 1,
): { customType: string; data: GsdStoredCandidatePlan } {
  return {
    customType: ENTRY.storedCandidatePlan,
    data: {
      id,
      iteration,
      path: `.gpd/candidate-plans/${id}.md`,
      plan,
    },
  };
}

function firstText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const item = result.content[0];
  return item && item.type === 'text' ? (item.text ?? '') : '';
}

function branchSession(
  entries: Array<{ customType?: string; data?: unknown }> = [],
) {
  return {
    getBranch: () => entries.map((entry) => ({ type: 'custom', ...entry })),
  };
}

function branchSessionWithPlan(
  plan: string,
  extraEntries: Array<{ customType?: string; data?: unknown }> = [],
  id: string = TEST_PLAN_ID,
) {
  return branchSession([storedPlanEntry(id, plan), ...extraEntries]);
}

function fencedJson(value: unknown): string {
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

function makePlanMarkdown(
  options: {
    planId?: string;
    phase?: string;
    reqIds?: string[];
    sliceReqIds?: string[];
  } = {},
): string {
  const planId = options.planId ?? '01-01';
  const phase = options.phase ?? '01';
  const reqIds = options.reqIds ?? ['REQ-01'];
  const sliceReqIds = options.sliceReqIds ?? reqIds;
  const suffix = sliceReqIds.length > 0 ? ` [${sliceReqIds.join(', ')}]` : '';
  return [
    fencedJson({
      id: planId,
      phase,
      reqIds,
      verify: 'npm run verify',
    }),
    '',
    `# Plan ${planId}`,
    '',
    '## Out of Scope',
    '',
    '- docs/generated/**',
    '',
    `### Slice 1: Implement scoped work${suffix}`,
    '',
    '#### Consumes',
    '',
    '_none_',
    '',
    '#### Produces',
    '',
    '- src/example.ts',
  ].join('\n');
}

function makeBundle(
  options: {
    planId?: string;
    phase?: string;
    phaseName?: string;
    reqIds?: string[];
    sliceReqIds?: string[];
    requirements?: Requirement[];
    phaseReqIds?: string[];
    statePointer?: string | null;
    statePlans?: StatePlan[];
    roadmapPhases?: RoadmapPhase[];
  } = {},
): string {
  const planId = options.planId ?? '01-01';
  const phase = options.phase ?? '01';
  const reqIds = options.reqIds ?? ['REQ-01'];
  const requirements = options.requirements ?? [
    { id: 'REQ-01', text: 'Implement scoped work.' },
  ];
  const roadmapPhases = options.roadmapPhases ?? [
    {
      id: phase,
      name: options.phaseName ?? 'Planning Artifacts',
      reqIds: options.phaseReqIds ?? reqIds,
      plans: [planId],
    },
  ];
  const statePlans = options.statePlans ?? [
    { id: planId, phase, status: 'planned' },
  ];
  return serializePlanBundle({
    planMarkdown: makePlanMarkdown({
      planId,
      phase,
      reqIds,
      sliceReqIds: options.sliceReqIds,
    }),
    requirements: { requirements },
    roadmap: { phases: roadmapPhases },
    state: {
      pointer:
        options.statePointer === undefined ? planId : options.statePointer,
      next: null,
      plans: statePlans,
    },
  });
}

function cleanCycle(
  bundle: string,
  options: {
    iteration?: number;
    blockers?: GsdReviewResult['blockers'];
    warnings?: GsdReviewResult['warnings'];
  } = {},
): GsdPlanReviewCycle {
  const blockers = options.blockers ?? [];
  const warnings = options.warnings ?? [];
  const review: GsdReviewResult = {
    blockers,
    warnings,
    nitpicks: [],
    summary: 'ready',
  };
  return {
    iteration: options.iteration ?? 1,
    ok: true,
    candidatePlan: bundle,
    raw: reviewJson(review),
    review,
    status:
      blockers.length > 0 || warnings.length > 0 ? 'needs-revision' : 'clean',
  };
}

function cleanBundleSession(bundle: string, iteration = 1) {
  return branchSession([
    {
      customType: ENTRY.planReviewCycle,
      data: cleanCycle(bundle, { iteration }),
    },
    contextEntry(iteration),
  ]);
}

async function assertPathMissing(path: string): Promise<void> {
  await assert.rejects(
    () => stat(path),
    (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
  );
}

test('toolValidatePlan: metadata says plan-reviewer does review work', () => {
  const tool = toolValidatePlan({
    appendEntry: () => {},
  });

  assert.ok(tool.description?.includes('does not review the bundle itself'));
  assert.ok(tool.promptSnippet?.includes('plan-reviewer subagent'));
  assert.ok(
    tool.promptGuidelines?.some((line) =>
      line.includes('This tool only parses and persists that review result'),
    ),
  );
});

test('toolValidatePlan: parses clean plan-reviewer output and stores cycle', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const tool = toolValidatePlan({
    appendEntry: (customType, data) => {
      appended.push({ customType, data });
    },
  });
  const result = await tool.execute(
    '1',
    {
      candidatePlanId: TEST_PLAN_ID,
      planningContext: planningContextJson(),
      reviewOutput: reviewJson({
        blockers: [],
        warnings: [],
        nitpicks: [{ issue: 'wording' }],
        summary: 'ready',
      }),
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSessionWithPlan('Candidate bundle body'),
    } as never,
  );

  assert.strictEqual(appended.length, 2);
  assert.strictEqual(appended[0]?.customType, ENTRY.planningContext);
  assert.strictEqual(appended[1]?.customType, ENTRY.planReviewCycle);
  const cycle = appended[1]?.data as GsdPlanReviewCycle;
  assert.strictEqual(cycle.ok, true);
  if (cycle.ok) {
    assert.strictEqual(cycle.status, 'clean');
    assert.strictEqual(cycle.candidatePlan, 'Candidate bundle body');
  }
  assert.ok(firstText(result).includes('blockers=0'));
});

test('toolValidatePlan: parse failure stores failed cycle', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const tool = toolValidatePlan({
    appendEntry: (customType, data) => {
      appended.push({ customType, data });
    },
  });
  const result = await tool.execute(
    '1',
    {
      candidatePlanId: TEST_PLAN_ID,
      planningContext: planningContextJson(),
      reviewOutput: 'not json',
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSessionWithPlan('Candidate bundle body'),
    } as never,
  );

  assert.strictEqual(appended.length, 2);
  const cycle = appended[1]?.data as GsdPlanReviewCycle;
  assert.strictEqual(cycle.ok, false);
  if (!cycle.ok) assert.strictEqual(cycle.status, 'parse');
  assert.ok(firstText(result).includes('review-result'));
});

test('toolValidatePlan: refuses when planningContext drifts from pinned iteration 1', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const tool = toolValidatePlan({
    appendEntry: (customType, data) => {
      appended.push({ customType, data });
    },
  });
  await tool.execute(
    '1',
    {
      candidatePlanId: TEST_PLAN_ID,
      planningContext: planningContextJson(),
      reviewOutput: reviewJson({
        blockers: [],
        warnings: [],
        nitpicks: [],
        summary: 'ready',
      }),
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSessionWithPlan('# Bundle'),
    } as never,
  );

  const drifted = planningContext();
  drifted.objective = 'build the thing but smaller';
  const result = await tool.execute(
    '2',
    {
      candidatePlanId: 'plan-test-id-2',
      planningContext: JSON.stringify(drifted),
      reviewOutput: reviewJson({
        blockers: [],
        warnings: [],
        nitpicks: [],
        summary: 'ready',
      }),
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSession([
        ...appended,
        storedPlanEntry('plan-test-id-2', '# Bundle v2', 2),
      ]),
    } as never,
  );

  assert.ok(firstText(result).includes('diverges from the pinned'));
  assert.strictEqual(
    (result.details as { reason: string }).reason,
    'context-drift',
  );
});

test('toolValidatePlan: reviewReadFingerprint guards stored bytes', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const tool = toolValidatePlan({
    appendEntry: (customType, data) => {
      appended.push({ customType, data });
    },
  });
  const result = await tool.execute(
    '1',
    {
      candidatePlanId: TEST_PLAN_ID,
      planningContext: planningContextJson(),
      reviewOutput: reviewJson({
        blockers: [],
        warnings: [],
        nitpicks: [],
        summary: 'ready',
        reviewReadFingerprint: { firstLine: 'other', lastLine: 'other' },
      }),
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSessionWithPlan('# Bundle'),
    } as never,
  );

  assert.ok(firstText(result).includes('reviewReadFingerprint'));
  const cycle = appended.find(
    (entry) => entry.customType === ENTRY.planReviewCycle,
  )?.data as GsdPlanReviewCycle;
  assert.strictEqual(cycle.ok, false);
});

test('planFingerprint: returns first and last non-empty trimmed lines', () => {
  const fp = planFingerprint('\r\n# Plan\r\n\r\nbody\r\n\r\n');
  assert.deepStrictEqual(fp, { firstLine: '# Plan', lastLine: 'body' });
});

test('toolStoreCandidatePlan: writes the plan bundle file and persists a session entry', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const dir = await mkdtemp(join(tmpdir(), 'gsd-store-'));
  try {
    const tool = toolStoreCandidatePlan({
      appendEntry: (customType, data) => {
        appended.push({ customType, data });
      },
    });
    const bundle = makeBundle();
    const result = await tool.execute(
      '1',
      { plan: bundle },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: branchSession(),
      } as never,
    );

    assert.strictEqual(appended.length, 1);
    assert.strictEqual(appended[0]?.customType, ENTRY.storedCandidatePlan);
    const stored = appended[0]?.data as GsdStoredCandidatePlan;
    assert.strictEqual(stored.plan, bundle);
    assert.strictEqual(await readFile(join(dir, stored.path), 'utf8'), bundle);
    assert.strictEqual((result.details as { ok: boolean }).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: refuses without persisted review', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const tool = toolFinalizePlan({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { markdown: makeBundle() },
      undefined,
      undefined,
      { cwd: dir, sessionManager: branchSession() } as never,
    );

    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'no-review',
    );
    await assertPathMissing(join(dir, 'docs'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: refuses failed latest cycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const bundle = makeBundle();
    const tool = toolFinalizePlan({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { markdown: bundle },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: branchSession([
          {
            customType: ENTRY.planReviewCycle,
            data: {
              iteration: 1,
              ok: false,
              candidatePlan: bundle,
              raw: 'bad json',
              status: 'parse',
              message: 'parse failed',
            } satisfies GsdPlanReviewCycle,
          },
          contextEntry(),
        ]),
      } as never,
    );

    assert.strictEqual((result.details as { reason: string }).reason, 'parse');
    await assertPathMissing(join(dir, 'docs'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: refuses without planning context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const bundle = makeBundle();
    const tool = toolFinalizePlan({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { markdown: bundle },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: branchSession([
          { customType: ENTRY.planReviewCycle, data: cleanCycle(bundle) },
        ]),
      } as never,
    );

    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'no-planning-context',
    );
    await assertPathMissing(join(dir, 'docs'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: refuses stale planning context iteration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const bundle = makeBundle();
    const tool = toolFinalizePlan({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { markdown: bundle },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: branchSession([
          contextEntry(1),
          {
            customType: ENTRY.planReviewCycle,
            data: cleanCycle(bundle, { iteration: 2 }),
          },
        ]),
      } as never,
    );

    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'no-planning-context',
    );
    await assertPathMissing(join(dir, 'docs'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: blockers can never be accepted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const bundle = makeBundle();
    const tool = toolFinalizePlan({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { markdown: bundle, acceptWarnings: true },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: branchSession([
          {
            customType: ENTRY.planReviewCycle,
            data: cleanCycle(bundle, {
              blockers: [{ issue: 'missing verification' }],
            }),
          },
          contextEntry(),
        ]),
      } as never,
    );

    assert.ok(firstText(result).includes('blockers'));
    await assertPathMissing(join(dir, 'docs'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: warnings require acceptWarnings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const bundle = makeBundle();
    const tool = toolFinalizePlan({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { markdown: bundle },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: branchSession([
          {
            customType: ENTRY.planReviewCycle,
            data: cleanCycle(bundle, {
              warnings: [{ issue: 'license unclear' }],
            }),
          },
          contextEntry(),
        ]),
      } as never,
    );

    assert.ok(firstText(result).includes('acceptWarnings'));
    await assertPathMissing(join(dir, 'docs'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: rejects stale markdown after clean review', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const bundle = makeBundle();
    const tool = toolFinalizePlan({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { markdown: makeBundle({ phaseName: 'Changed' }) },
      undefined,
      undefined,
      { cwd: dir, sessionManager: cleanBundleSession(bundle) } as never,
    );

    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'stale-review',
    );
    await assertPathMissing(join(dir, 'docs'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: writes phase artifacts, living docs, planned state, and rendered context', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const bundle = makeBundle();
    const tool = toolFinalizePlan({
      appendEntry: (customType, data) => appended.push({ customType, data }),
    });
    const result = await tool.execute(
      '1',
      { markdown: bundle },
      undefined,
      undefined,
      { cwd: dir, sessionManager: cleanBundleSession(bundle) } as never,
    );

    assert.strictEqual((result.details as { ok: boolean }).ok, true);
    const phaseDir = join(dir, 'docs', 'phases', '01-planning-artifacts');
    const context = await readFile(join(phaseDir, '01-CONTEXT.md'), 'utf8');
    assert.ok(context.includes('# Phase 01: Planning Artifacts'));
    assert.ok(context.includes('## Findings\n\n- uses node:test'));
    assert.ok(
      context.includes('## Decisions\n\n- use TypeScript\n- pi SDK available'),
    );
    assert.ok(context.includes('## Deferred Unknowns\n\n- execution order'));

    const plan = await readFile(join(phaseDir, '01-01-PLAN.md'), 'utf8');
    assert.strictEqual(plan, makePlanMarkdown() + '\n');

    assert.deepStrictEqual(
      parseRequirementsDoc(
        await readFile(join(dir, 'docs', 'REQUIREMENTS.md'), 'utf8'),
      ),
      { requirements: [{ id: 'REQ-01', text: 'Implement scoped work.' }] },
    );
    assert.deepStrictEqual(
      parseRoadmapDoc(await readFile(join(dir, 'docs', 'ROADMAP.md'), 'utf8'))
        .phases[0]?.plans,
      ['01-01'],
    );
    assert.deepStrictEqual(
      parseStateDoc(await readFile(join(dir, 'docs', 'STATE.md'), 'utf8')),
      {
        pointer: '01-01',
        next: {
          command: '/build',
          planId: '01-01',
          reason: 'planned-but-unbuilt',
        },
        plans: [{ id: '01-01', phase: '01', status: 'planned' }],
      },
    );
    assert.strictEqual(appended[0]?.customType, ENTRY.planFinalized);
    const finalized = appended[0]?.data as GsdPlanFinalized;
    assert.strictEqual(finalized.planId, '01-01');
    assert.deepStrictEqual(finalized.paths, [
      'docs/phases/01-planning-artifacts/01-CONTEXT.md',
      'docs/phases/01-planning-artifacts/01-01-PLAN.md',
      'docs/REQUIREMENTS.md',
      'docs/ROADMAP.md',
      'docs/STATE.md',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: accepts warnings when acceptWarnings is true', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const bundle = makeBundle();
    const tool = toolFinalizePlan({
      appendEntry: (customType, data) => appended.push({ customType, data }),
    });
    const result = await tool.execute(
      '1',
      { markdown: bundle, acceptWarnings: true },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: branchSession([
          {
            customType: ENTRY.planReviewCycle,
            data: cleanCycle(bundle, {
              warnings: [{ issue: 'license unclear' }],
            }),
          },
          contextEntry(),
        ]),
      } as never,
    );

    assert.strictEqual((result.details as { ok: boolean }).ok, true);
    assert.strictEqual(
      (appended[0]?.data as GsdPlanFinalized).acceptedWarnings,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: fresh-repo bootstrap creates all docs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-fresh-'));
  try {
    const bundle = makeBundle({ planId: '01-01' });
    const tool = toolFinalizePlan({ appendEntry: () => {} });
    await tool.execute('1', { markdown: bundle }, undefined, undefined, {
      cwd: dir,
      sessionManager: cleanBundleSession(bundle),
    } as never);

    for (const rel of [
      'docs/phases/01-planning-artifacts/01-CONTEXT.md',
      'docs/phases/01-planning-artifacts/01-01-PLAN.md',
      'docs/REQUIREMENTS.md',
      'docs/ROADMAP.md',
      'docs/STATE.md',
    ]) {
      await stat(join(dir, rel));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function assertFinalizeRefusal(
  bundle: string,
  expectedReason: string,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-refuse-'));
  try {
    const tool = toolFinalizePlan({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { markdown: bundle },
      undefined,
      undefined,
      { cwd: dir, sessionManager: cleanBundleSession(bundle) } as never,
    );
    assert.strictEqual(
      (result.details as { reason: string }).reason,
      expectedReason,
    );
    await assertPathMissing(join(dir, 'docs'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('toolFinalizePlan: refuses unresolved requirement ids', async () => {
  await assertFinalizeRefusal(
    makeBundle({
      reqIds: ['REQ-01', 'REQ-02'],
      sliceReqIds: ['REQ-02'],
      phaseReqIds: ['REQ-01'],
    }),
    'unresolved-req',
  );
});

test('toolFinalizePlan: refuses slice req ids not claimed by plan metadata', async () => {
  await assertFinalizeRefusal(
    makeBundle({
      reqIds: ['REQ-01'],
      sliceReqIds: ['REQ-02'],
      requirements: [
        { id: 'REQ-01', text: 'First requirement.' },
        { id: 'REQ-02', text: 'Second requirement.' },
      ],
    }),
    'slice-req-not-claimed',
  );
});

test('toolFinalizePlan: refuses bad roadmap requirement refs', async () => {
  await assertFinalizeRefusal(
    makeBundle({ phaseReqIds: ['REQ-01', 'REQ-02'] }),
    'bad-roadmap-ref',
  );
});

test('toolFinalizePlan: refuses bad state pointer', async () => {
  await assertFinalizeRefusal(
    makeBundle({ statePointer: '09-99' }),
    'bad-state-pointer',
  );
});

test('toolFinalizePlan: refuses reverse coverage gaps', async () => {
  await assertFinalizeRefusal(
    makeBundle({
      reqIds: ['REQ-01', 'REQ-02'],
      sliceReqIds: ['REQ-01'],
      requirements: [
        { id: 'REQ-01', text: 'First requirement.' },
        { id: 'REQ-02', text: 'Second requirement.' },
      ],
      phaseReqIds: ['REQ-01', 'REQ-02'],
    }),
    'reverse-coverage',
  );
});

test('toolFinalizePlan: empty plan reqIds skips reverse coverage check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-empty-reqs-'));
  try {
    const bundle = makeBundle({
      reqIds: [],
      sliceReqIds: [],
      phaseReqIds: ['REQ-01'],
    });
    const tool = toolFinalizePlan({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { markdown: bundle },
      undefined,
      undefined,
      { cwd: dir, sessionManager: cleanBundleSession(bundle) } as never,
    );
    assert.strictEqual((result.details as { ok: boolean }).ok, true);
    await stat(
      join(dir, 'docs', 'phases', '01-planning-artifacts', '01-01-PLAN.md'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: refuses when state does not mark plan planned', async () => {
  await assertFinalizeRefusal(
    makeBundle({
      statePointer: null,
      statePlans: [{ id: '01-01', phase: '01', status: 'pending' }],
    }),
    'plan-not-planned',
  );
});

test('toolFinalizePlan: refuses a traversal plan id without writes', async () => {
  await assertFinalizeRefusal(
    makeBundle({
      planId: '../../../etc/pwn',
      statePointer: '../../../etc/pwn',
      statePlans: [{ id: '../../../etc/pwn', phase: '01', status: 'planned' }],
    }),
    'bad-plan-id',
  );
});

test('toolFinalizePlan: refuses a traversal phase id without writes', async () => {
  await assertFinalizeRefusal(
    makeBundle({
      planId: '01-01',
      phase: '../../evil',
      statePlans: [{ id: '01-01', phase: '01', status: 'planned' }],
      roadmapPhases: [
        {
          id: '../../evil',
          name: 'Escape',
          reqIds: ['REQ-01'],
          plans: ['01-01'],
        },
      ],
    }),
    'bad-phase-id',
  );
});

test('toolFinalizePlan: bundle parse errors refuse without writes', async () => {
  const bundle = makeBundle().replace('<!-- gpd:section=state -->', '');
  await assertFinalizeRefusal(bundle, 'bundle-parse');
});

test('toolFinalizePlan: clears .gpd/candidate-plans/ on successful finalize', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-cleanup-'));
  try {
    const { mkdir: mkdirFs, writeFile: writeFileFs } =
      await import('node:fs/promises');
    const planDir = join(dir, '.gpd', 'candidate-plans');
    await mkdirFs(planDir, { recursive: true });
    await writeFileFs(join(planDir, 'stale.md'), '# stale', 'utf8');

    const bundle = makeBundle();
    const tool = toolFinalizePlan({ appendEntry: () => {} });
    await tool.execute('1', { markdown: bundle }, undefined, undefined, {
      cwd: dir,
      sessionManager: cleanBundleSession(bundle),
    } as never);

    await assertPathMissing(planDir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
