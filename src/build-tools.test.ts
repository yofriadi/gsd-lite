import assert from 'node:assert';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  advanceStateAfterBuild,
  deriveCommitRange,
  pathMatchesOutOfScope,
  toolFinalizeBuild,
  toolStoreCandidateChange,
  toolValidateChange,
} from './build-tools.js';
import {
  parseRequirementsDoc,
  parseStateDoc,
  serializePlanDoc,
  serializeRequirementsBlock,
  serializeRoadmapBlock,
  serializeStateBlock,
} from './doc-parse.js';
import { planFingerprint } from './plan-tools.js';
import {
  ENTRY,
  type GsdBuildFinalized,
  type GsdChangeReviewCycle,
  type GsdReviewResult,
  type GsdStoredCandidateChange,
  type PlanDoc,
  type Requirement,
  type RequirementsDoc,
  type RoadmapDoc,
  type StateLedger,
} from './types.js';

const execFileAsync = promisify(execFile);

const TEST_CHANGE_ID = 'change-test-id';
const TEST_PLAN_ID = '01-01';
const TEST_SLICE_N = 1;
const CHANGE_DOC = ['# Change Summary', '', 'Implemented slice 1.'].join('\n');

function reviewJson(review: GsdReviewResult): string {
  return ['```json', JSON.stringify(review, null, 2), '```'].join('\n');
}

function cleanReview(extra: Partial<GsdReviewResult> = {}): GsdReviewResult {
  return {
    blockers: [],
    warnings: [],
    nitpicks: [],
    summary: 'ready',
    ...extra,
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

function entriesSession(
  entries: Array<{
    customType?: string;
    data?: unknown;
    details?: unknown;
  }> = [],
) {
  return {
    getEntries: () => entries.map((entry) => ({ type: 'custom', ...entry })),
    getBranch: () => [],
  };
}

function defaultPlan(overrides: Partial<PlanDoc> = {}): PlanDoc {
  return {
    id: TEST_PLAN_ID,
    phase: '01',
    reqIds: ['REQ-01'],
    verify: 'npm run verify',
    outOfScope: ['docs/forbidden/**'],
    slices: [
      {
        n: 1,
        title: 'Implement scoped work',
        reqIds: ['REQ-01'],
        consumes: [],
        produces: ['src/example.ts'],
      },
    ],
    ...overrides,
  };
}

function defaultRoadmap(planIds: string[] = [TEST_PLAN_ID]): RoadmapDoc {
  return {
    phases: [
      {
        id: '01',
        name: 'Planning Artifacts',
        reqIds: ['REQ-01'],
        plans: planIds,
      },
    ],
  };
}

function defaultState(
  plans: StateLedger['plans'] = [
    { id: TEST_PLAN_ID, phase: '01', status: 'planned' },
  ],
): StateLedger {
  return {
    pointer: plans[0]?.id ?? null,
    next: null,
    plans,
  };
}

function defaultRequirements(
  requirements: Requirement[] = [
    { id: 'REQ-01', text: 'Implement scoped work.' },
  ],
): RequirementsDoc {
  return { requirements };
}

async function writeFinalizeDocs(
  cwd: string,
  options: {
    plan?: PlanDoc;
    roadmap?: RoadmapDoc;
    state?: StateLedger;
    requirements?: RequirementsDoc;
  } = {},
): Promise<void> {
  const plan = options.plan ?? defaultPlan();
  const roadmap = options.roadmap ?? defaultRoadmap();
  const state = options.state ?? defaultState();
  const requirements = options.requirements ?? defaultRequirements();
  const phase = roadmap.phases.find((candidate) => candidate.id === plan.phase);
  assert.ok(phase);
  const phaseDir = join(cwd, 'docs', 'phases', '01-planning-artifacts');
  await mkdir(phaseDir, { recursive: true });
  await writeFile(
    join(cwd, 'docs', 'STATE.md'),
    serializeStateBlock(state),
    'utf8',
  );
  await writeFile(
    join(cwd, 'docs', 'ROADMAP.md'),
    serializeRoadmapBlock(roadmap),
    'utf8',
  );
  await writeFile(
    join(cwd, 'docs', 'REQUIREMENTS.md'),
    serializeRequirementsBlock(requirements),
    'utf8',
  );
  await writeFile(
    join(phaseDir, `${plan.id}-PLAN.md`),
    serializePlanDoc(plan),
    'utf8',
  );
}

function sliceResultEntry(
  commitRange: string,
  sliceN = TEST_SLICE_N,
): { customType: string; details: unknown } {
  return {
    customType: 'gpd-slice-result',
    details: {
      path: `.gpd/slice-results/${TEST_PLAN_ID}-slice-${sliceN}.md`,
      digest: 'abc123',
      counts: { blockers: 0, warnings: 0, nitpicks: 0 },
      verify: { command: 'npm run verify', exitCode: 0, ok: true },
      outcome: 'clean',
      commitRange,
    },
  };
}

function storedChange(
  options: {
    id?: string;
    iteration?: number;
    planId?: string;
    sliceN?: number;
    change?: string;
    touchedFiles?: string[];
  } = {},
): GsdStoredCandidateChange {
  const id = options.id ?? TEST_CHANGE_ID;
  return {
    id,
    iteration: options.iteration ?? 1,
    planId: options.planId ?? TEST_PLAN_ID,
    sliceN: options.sliceN ?? TEST_SLICE_N,
    path: `.gpd/candidate-changes/${id}.md`,
    change: options.change ?? CHANGE_DOC,
    ...(options.touchedFiles ? { touchedFiles: options.touchedFiles } : {}),
  };
}

function storedChangeEntry(options: Parameters<typeof storedChange>[0] = {}): {
  customType: string;
  data: GsdStoredCandidateChange;
} {
  return {
    customType: ENTRY.storedCandidateChange,
    data: storedChange(options),
  };
}

function cleanCycle(
  options: {
    iteration?: number;
    planId?: string;
    sliceN?: number;
    change?: string;
    verifyOk?: boolean;
    verifyCommand?: string | null;
  } = {},
): GsdChangeReviewCycle {
  const verifyCommand = options.verifyCommand ?? 'npm run verify';
  const verify =
    options.verifyOk === false
      ? { command: verifyCommand, exitCode: 1, ok: false }
      : { command: verifyCommand, exitCode: 0, ok: true };
  return {
    iteration: options.iteration ?? 1,
    planId: options.planId ?? TEST_PLAN_ID,
    sliceN: options.sliceN ?? TEST_SLICE_N,
    ok: true,
    candidateChange: options.change ?? CHANGE_DOC,
    raw: reviewJson(cleanReview()),
    review: cleanReview(),
    verify,
    status: verify.ok ? 'clean' : 'needs-revision',
  };
}

function reviewedCycle(
  options: Parameters<typeof cleanCycle>[0] & {
    blockers?: GsdReviewResult['blockers'];
    warnings?: GsdReviewResult['warnings'];
  } = {},
): GsdChangeReviewCycle {
  const cycle = cleanCycle(options);
  if (!cycle.ok) return cycle;
  cycle.review = cleanReview({
    blockers: options.blockers ?? [],
    warnings: options.warnings ?? [],
  });
  cycle.raw = reviewJson(cycle.review);
  cycle.status =
    cycle.review.blockers.length === 0 &&
    cycle.review.warnings.length === 0 &&
    cycle.verify.ok
      ? 'clean'
      : 'needs-revision';
  return cycle;
}

function changeCycleEntry(cycle: GsdChangeReviewCycle): {
  customType: string;
  data: GsdChangeReviewCycle;
} {
  return { customType: ENTRY.changeReviewCycle, data: cycle };
}

async function assertPathExists(path: string): Promise<void> {
  await stat(path);
}

test('toolStoreCandidateChange: writes change doc, persists entry, and returns id/path', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const dir = await mkdtemp(join(tmpdir(), 'gsd-store-change-'));
  try {
    const tool = toolStoreCandidateChange({
      appendEntry: (customType, data) => appended.push({ customType, data }),
    });
    const result = await tool.execute(
      '1',
      {
        change: CHANGE_DOC,
        planId: TEST_PLAN_ID,
        sliceN: TEST_SLICE_N,
        touchedFiles: ['src/build-tools.ts'],
      },
      undefined,
      undefined,
      { cwd: dir, sessionManager: branchSession() } as never,
    );

    assert.strictEqual(appended.length, 1);
    assert.strictEqual(appended[0]?.customType, ENTRY.storedCandidateChange);
    const stored = appended[0]?.data as GsdStoredCandidateChange;
    assert.strictEqual(stored.change, CHANGE_DOC);
    assert.strictEqual(stored.iteration, 1);
    assert.strictEqual(stored.planId, TEST_PLAN_ID);
    assert.strictEqual(stored.sliceN, TEST_SLICE_N);
    assert.deepStrictEqual(stored.touchedFiles, ['src/build-tools.ts']);
    assert.strictEqual(
      await readFile(join(dir, stored.path), 'utf8'),
      CHANGE_DOC,
    );
    assert.strictEqual((result.details as { ok: boolean }).ok, true);
    assert.strictEqual((result.details as { id: string }).id, stored.id);
    assert.strictEqual((result.details as { path: string }).path, stored.path);
    assert.ok(firstText(result).includes('validate-change'));
    await assertPathExists(join(dir, '.gpd', 'candidate-changes'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolStoreCandidateChange: git-derived touched files include untracked files', async (t) => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const dir = await mkdtemp(join(tmpdir(), 'gsd-store-change-git-'));
  try {
    try {
      await execFileAsync('git', ['init'], { cwd: dir });
    } catch {
      t.skip('git unavailable');
      return;
    }

    await writeFile(join(dir, 'new-untracked.md'), 'new file\n', 'utf8');
    const tool = toolStoreCandidateChange({
      appendEntry: (customType, data) => appended.push({ customType, data }),
    });
    await tool.execute(
      '1',
      {
        change: CHANGE_DOC,
        planId: TEST_PLAN_ID,
        sliceN: TEST_SLICE_N,
      },
      undefined,
      undefined,
      { cwd: dir, sessionManager: branchSession() } as never,
    );

    const stored = appended[0]?.data as GsdStoredCandidateChange;
    assert.ok(stored.touchedFiles?.includes('new-untracked.md'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolValidateChange: out-of-scope violation injects blocker and prevents clean cycle', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const tool = toolValidateChange({
    appendEntry: (customType, data) => appended.push({ customType, data }),
  });
  const result = await tool.execute(
    '1',
    {
      candidateChangeId: TEST_CHANGE_ID,
      planId: TEST_PLAN_ID,
      sliceN: TEST_SLICE_N,
      reviewOutput: reviewJson(cleanReview()),
      verifyCommand: 'npm run verify',
      verifyExitCode: 0,
      outOfScope: ['docs/'],
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSession([
        storedChangeEntry({ touchedFiles: ['docs/STATE.md'] }),
      ]),
    } as never,
  );

  assert.ok(firstText(result).includes('blockers=1'));
  assert.strictEqual(appended.length, 1);
  const cycle = appended[0]?.data as GsdChangeReviewCycle;
  assert.strictEqual(cycle.ok, true);
  if (cycle.ok) {
    assert.strictEqual(cycle.status, 'needs-revision');
    assert.ok(
      cycle.review.blockers.some((entry) =>
        entry.issue.includes('out-of-scope path touched: docs/STATE.md'),
      ),
    );
  }
});

test('toolValidateChange: out-of-scope clean control persists clean cycle', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const tool = toolValidateChange({
    appendEntry: (customType, data) => appended.push({ customType, data }),
  });
  await tool.execute(
    '1',
    {
      candidateChangeId: TEST_CHANGE_ID,
      planId: TEST_PLAN_ID,
      sliceN: TEST_SLICE_N,
      reviewOutput: reviewJson(cleanReview()),
      verifyCommand: 'npm run verify',
      verifyExitCode: 0,
      outOfScope: ['docs/'],
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSession([
        storedChangeEntry({ touchedFiles: ['src/build-tools.ts'] }),
      ]),
    } as never,
  );

  const cycle = appended[0]?.data as GsdChangeReviewCycle;
  assert.strictEqual(cycle.ok, true);
  if (cycle.ok) {
    assert.strictEqual(cycle.status, 'clean');
    assert.deepStrictEqual(cycle.review.blockers, []);
  }
});

test('toolValidateChange: failing verify with clean review is needs-revision and never clean', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const tool = toolValidateChange({
    appendEntry: (customType, data) => appended.push({ customType, data }),
  });
  const result = await tool.execute(
    '1',
    {
      candidateChangeId: TEST_CHANGE_ID,
      planId: TEST_PLAN_ID,
      sliceN: TEST_SLICE_N,
      reviewOutput: reviewJson(cleanReview()),
      verifyCommand: 'npm run verify',
      verifyExitCode: 1,
      outOfScope: [],
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSession([storedChangeEntry()]),
    } as never,
  );

  assert.ok(firstText(result).includes('verify=FAIL(exit 1)'));
  const cycle = appended[0]?.data as GsdChangeReviewCycle;
  assert.strictEqual(cycle.ok, true);
  if (cycle.ok) {
    assert.strictEqual(cycle.status, 'needs-revision');
    assert.deepStrictEqual(cycle.verify, {
      command: 'npm run verify',
      exitCode: 1,
      ok: false,
    });
  }
});

test('toolValidateChange: passing verify clean control persists clean cycle', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const tool = toolValidateChange({
    appendEntry: (customType, data) => appended.push({ customType, data }),
  });
  await tool.execute(
    '1',
    {
      candidateChangeId: TEST_CHANGE_ID,
      planId: TEST_PLAN_ID,
      sliceN: TEST_SLICE_N,
      reviewOutput: reviewJson(cleanReview()),
      verifyCommand: 'npm run verify',
      verifyExitCode: 0,
      outOfScope: [],
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSession([storedChangeEntry()]),
    } as never,
  );

  const cycle = appended[0]?.data as GsdChangeReviewCycle;
  assert.strictEqual(cycle.ok, true);
  if (cycle.ok) {
    assert.strictEqual(cycle.status, 'clean');
    assert.deepStrictEqual(cycle.verify, {
      command: 'npm run verify',
      exitCode: 0,
      ok: true,
    });
  }
});

test('toolValidateChange: verify none records ok true', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const tool = toolValidateChange({
    appendEntry: (customType, data) => appended.push({ customType, data }),
  });
  await tool.execute(
    '1',
    {
      candidateChangeId: TEST_CHANGE_ID,
      planId: TEST_PLAN_ID,
      sliceN: TEST_SLICE_N,
      reviewOutput: reviewJson(cleanReview()),
      verifyCommand: null,
      verifyExitCode: null,
      outOfScope: [],
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSession([storedChangeEntry()]),
    } as never,
  );

  const cycle = appended[0]?.data as GsdChangeReviewCycle;
  assert.strictEqual(cycle.ok, true);
  if (cycle.ok) {
    assert.strictEqual(cycle.status, 'clean');
    assert.deepStrictEqual(cycle.verify, {
      command: null,
      exitCode: null,
      ok: true,
    });
  }
});

test('toolValidateChange: refuses unknown candidateChangeId', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const tool = toolValidateChange({
    appendEntry: (customType, data) => appended.push({ customType, data }),
  });
  const result = await tool.execute(
    '1',
    {
      candidateChangeId: 'missing',
      planId: TEST_PLAN_ID,
      sliceN: TEST_SLICE_N,
      reviewOutput: reviewJson(cleanReview()),
      verifyCommand: 'npm run verify',
      verifyExitCode: 0,
      outOfScope: [],
    },
    undefined,
    undefined,
    { cwd: process.cwd(), sessionManager: branchSession() } as never,
  );

  assert.strictEqual(
    (result.details as { reason: string }).reason,
    'unknown-candidate-change-id',
  );
  assert.strictEqual(appended.length, 0);
});

test('toolValidateChange: refuses candidate scope mismatch without appending a cycle', async () => {
  const cases = [
    {
      name: 'planId',
      stored: storedChangeEntry({ planId: 'A', sliceN: 1 }),
      params: { planId: 'B', sliceN: 1 },
    },
    {
      name: 'sliceN',
      stored: storedChangeEntry({ planId: 'A', sliceN: 1 }),
      params: { planId: 'A', sliceN: 2 },
    },
  ];

  for (const testCase of cases) {
    const appended: Array<{ customType: string; data: unknown }> = [];
    const tool = toolValidateChange({
      appendEntry: (customType, data) => appended.push({ customType, data }),
    });
    const result = await tool.execute(
      '1',
      {
        candidateChangeId: TEST_CHANGE_ID,
        planId: testCase.params.planId,
        sliceN: testCase.params.sliceN,
        reviewOutput: reviewJson(cleanReview()),
        verifyCommand: 'npm run verify',
        verifyExitCode: 0,
        outOfScope: [],
      },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        sessionManager: branchSession([testCase.stored]),
      } as never,
    );

    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'candidate-scope-mismatch',
      testCase.name,
    );
    assert.strictEqual(appended.length, 0, testCase.name);
  }
});

test('toolValidateChange: refuses iteration mismatch', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const tool = toolValidateChange({
    appendEntry: (customType, data) => appended.push({ customType, data }),
  });
  const result = await tool.execute(
    '1',
    {
      candidateChangeId: TEST_CHANGE_ID,
      planId: TEST_PLAN_ID,
      sliceN: TEST_SLICE_N,
      reviewOutput: reviewJson(cleanReview()),
      verifyCommand: 'npm run verify',
      verifyExitCode: 0,
      outOfScope: [],
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSession([
        storedChangeEntry({ iteration: 1 }),
        changeCycleEntry(cleanCycle({ iteration: 1 })),
      ]),
    } as never,
  );

  assert.strictEqual(
    (result.details as { reason: string }).reason,
    'iteration-mismatch',
  );
  assert.strictEqual(appended.length, 0);
});

test('toolValidateChange: aborted review persists failed cycle with verify result', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const tool = toolValidateChange({
    appendEntry: (customType, data) => appended.push({ customType, data }),
  });
  const result = await tool.execute(
    '1',
    {
      candidateChangeId: TEST_CHANGE_ID,
      planId: TEST_PLAN_ID,
      sliceN: TEST_SLICE_N,
      reviewOutput: '',
      reviewStatus: 'aborted',
      verifyCommand: 'npm run verify',
      verifyExitCode: 0,
      outOfScope: [],
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSession([storedChangeEntry()]),
    } as never,
  );

  assert.ok(
    firstText(result).includes('code-reviewer finished with status aborted'),
  );
  assert.strictEqual(appended[0]?.customType, ENTRY.changeReviewCycle);
  const cycle = appended[0]?.data as GsdChangeReviewCycle;
  assert.strictEqual(cycle.ok, false);
  if (!cycle.ok) {
    assert.strictEqual(cycle.status, 'aborted');
    assert.deepStrictEqual(cycle.verify, {
      command: 'npm run verify',
      exitCode: 0,
      ok: true,
    });
  }
});

test('toolValidateChange: fingerprint mismatch persists parse failure cycle', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const tool = toolValidateChange({
    appendEntry: (customType, data) => appended.push({ customType, data }),
  });
  const actual = planFingerprint(CHANGE_DOC);
  const result = await tool.execute(
    '1',
    {
      candidateChangeId: TEST_CHANGE_ID,
      planId: TEST_PLAN_ID,
      sliceN: TEST_SLICE_N,
      reviewOutput: reviewJson(
        cleanReview({
          reviewReadFingerprint: {
            firstLine: `${actual.firstLine} changed`,
            lastLine: actual.lastLine,
          },
        }),
      ),
      verifyCommand: 'npm run verify',
      verifyExitCode: 0,
      outOfScope: [],
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSession([storedChangeEntry()]),
    } as never,
  );

  assert.ok(firstText(result).includes('reviewReadFingerprint'));
  const cycle = appended[0]?.data as GsdChangeReviewCycle;
  assert.strictEqual(cycle.ok, false);
  if (!cycle.ok) assert.strictEqual(cycle.status, 'parse');
});

test('toolFinalizeBuild: writes summary, advances state, closes requirements, and appends build-finalized', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-build-'));
  try {
    await writeFinalizeDocs(dir);
    const tool = toolFinalizeBuild({
      appendEntry: (customType, data) => appended.push({ customType, data }),
    });
    const result = await tool.execute(
      '1',
      {
        planId: TEST_PLAN_ID,
        summary: 'Built the scoped work.',
        deliverables: ['src/example.ts'],
      },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: entriesSession([
          storedChangeEntry({ touchedFiles: ['src/example.ts'] }),
          changeCycleEntry(cleanCycle()),
          sliceResultEntry('abc..def'),
        ]),
      } as never,
    );

    assert.strictEqual((result.details as { ok: boolean }).ok, true);
    const summary = await readFile(
      join(
        dir,
        'docs',
        'phases',
        '01-planning-artifacts',
        `${TEST_PLAN_ID}-SUMMARY.md`,
      ),
      'utf8',
    );
    assert.ok(summary.includes(`# Summary ${TEST_PLAN_ID}`));
    assert.ok(summary.includes('## Summary\n\nBuilt the scoped work.'));
    assert.ok(summary.includes('- src/example.ts'));
    assert.ok(summary.includes('- REQ-01: Implement scoped work.'));
    assert.ok(
      summary.includes(
        '| Cycle | Slice | Blockers | Verify | Revision | Result |',
      ),
    );
    assert.ok(summary.includes('| 1 | 1 | 0 | pass | 1 | clean |'));

    const state = parseStateDoc(
      await readFile(join(dir, 'docs', 'STATE.md'), 'utf8'),
    );
    assert.deepStrictEqual(state, {
      pointer: null,
      next: null,
      plans: [{ id: TEST_PLAN_ID, phase: '01', status: 'built' }],
    });

    const requirements = parseRequirementsDoc(
      await readFile(join(dir, 'docs', 'REQUIREMENTS.md'), 'utf8'),
    );
    assert.deepStrictEqual(requirements.requirements[0], {
      id: 'REQ-01',
      text: 'Implement scoped work.',
      satisfiedBy: TEST_PLAN_ID,
      summary: `docs/phases/01-planning-artifacts/${TEST_PLAN_ID}-SUMMARY.md`,
      validatedBy: 'code-reviewer',
      verify: { command: 'npm run verify', ok: true },
      evidence: 'abc..def',
    });
    assert.strictEqual(appended[0]?.customType, ENTRY.buildFinalized);
    const finalized = appended[0]?.data as GsdBuildFinalized;
    assert.strictEqual(finalized.planId, TEST_PLAN_ID);
    assert.strictEqual(finalized.phaseId, '01');
    assert.deepStrictEqual(finalized.reqIds, ['REQ-01']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizeBuild: STATE next is /build for planned, null when all built, and /plan for pending', async () => {
  const cases: Array<{
    name: string;
    plans: StateLedger['plans'];
    expected: Pick<StateLedger, 'pointer' | 'next'>;
  }> = [
    {
      name: 'planned follow-on',
      plans: [
        { id: TEST_PLAN_ID, phase: '01', status: 'planned' },
        { id: '01-02', phase: '01', status: 'planned' },
      ],
      expected: {
        pointer: '01-02',
        next: {
          command: '/build',
          planId: '01-02',
          reason: 'planned-but-unbuilt',
        },
      },
    },
    {
      name: 'all built',
      plans: [{ id: TEST_PLAN_ID, phase: '01', status: 'planned' }],
      expected: { pointer: null, next: null },
    },
    {
      name: 'pending follow-on',
      plans: [
        { id: TEST_PLAN_ID, phase: '01', status: 'planned' },
        { id: '01-02', phase: '01', status: 'pending' },
      ],
      expected: {
        pointer: '01-02',
        next: {
          command: '/plan',
          planId: '01-02',
          reason: 'roadmap-item-pending',
        },
      },
    },
  ];

  for (const testCase of cases) {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-build-state-'));
    try {
      await writeFinalizeDocs(dir, {
        roadmap: defaultRoadmap(testCase.plans.map((plan) => plan.id)),
        state: defaultState(testCase.plans),
      });
      const tool = toolFinalizeBuild({ appendEntry: () => {} });
      await tool.execute(
        '1',
        { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
        undefined,
        undefined,
        {
          cwd: dir,
          sessionManager: entriesSession([
            storedChangeEntry({ touchedFiles: ['src/example.ts'] }),
            changeCycleEntry(cleanCycle()),
          ]),
        } as never,
      );
      const state = parseStateDoc(
        await readFile(join(dir, 'docs', 'STATE.md'), 'utf8'),
      );
      assert.strictEqual(
        state.pointer,
        testCase.expected.pointer,
        testCase.name,
      );
      assert.deepStrictEqual(state.next, testCase.expected.next, testCase.name);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  assert.strictEqual(
    advanceStateAfterBuild(defaultState(), defaultRoadmap(), TEST_PLAN_ID)
      .pointer,
    null,
  );
});

test('toolFinalizeBuild: refuses blockers without writing docs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-build-blockers-'));
  try {
    await writeFinalizeDocs(dir);
    const before = await readFile(join(dir, 'docs', 'STATE.md'), 'utf8');
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: entriesSession([
          changeCycleEntry(
            reviewedCycle({ blockers: [{ issue: 'bug', fix: 'fix it' }] }),
          ),
        ]),
      } as never,
    );

    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'blockers',
    );
    assert.strictEqual(
      await readFile(join(dir, 'docs', 'STATE.md'), 'utf8'),
      before,
    );
    await assert.rejects(
      () =>
        stat(
          join(
            dir,
            'docs',
            'phases',
            '01-planning-artifacts',
            `${TEST_PLAN_ID}-SUMMARY.md`,
          ),
        ),
      (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizeBuild: refuses verify failure even with acceptWarnings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-build-verify-'));
  try {
    await writeFinalizeDocs(dir);
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      {
        planId: TEST_PLAN_ID,
        summary: 'done',
        deliverables: [],
        acceptWarnings: true,
      },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: entriesSession([
          changeCycleEntry(cleanCycle({ verifyOk: false })),
        ]),
      } as never,
    );

    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'verify-failed',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizeBuild: accepts warnings-only slices only with acceptWarnings', async () => {
  const warningCycle = reviewedCycle({ warnings: [{ issue: 'minor' }] });
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-build-warnings-'));
  try {
    await writeFinalizeDocs(dir);
    const refusedTool = toolFinalizeBuild({ appendEntry: () => {} });
    const refused = await refusedTool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: entriesSession([changeCycleEntry(warningCycle)]),
      } as never,
    );
    assert.strictEqual(
      (refused.details as { reason: string }).reason,
      'warnings',
    );

    const appended: Array<{ customType: string; data: unknown }> = [];
    const acceptedTool = toolFinalizeBuild({
      appendEntry: (customType, data) => appended.push({ customType, data }),
    });
    const accepted = await acceptedTool.execute(
      '2',
      {
        planId: TEST_PLAN_ID,
        summary: 'done',
        deliverables: [],
        acceptWarnings: true,
      },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: entriesSession([
          storedChangeEntry({ touchedFiles: ['src/example.ts'] }),
          changeCycleEntry(warningCycle),
        ]),
      } as never,
    );
    assert.strictEqual((accepted.details as { ok: boolean }).ok, true);
    assert.strictEqual(
      (appended[0]?.data as GsdBuildFinalized).acceptedWarnings,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizeBuild: refuses unresolved requirement ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-build-req-'));
  try {
    await writeFinalizeDocs(dir, {
      plan: defaultPlan({ reqIds: ['REQ-01', 'REQ-02'] }),
    });
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: entriesSession([
          storedChangeEntry({ touchedFiles: ['src/example.ts'] }),
          changeCycleEntry(cleanCycle()),
        ]),
      } as never,
    );

    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'unresolved-req',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizeBuild: refuses out-of-scope touched files and succeeds for in-scope control', async () => {
  const dirtyDir = await mkdtemp(join(tmpdir(), 'gsd-finalize-build-oos-'));
  try {
    await writeFinalizeDocs(dirtyDir);
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: dirtyDir,
        sessionManager: entriesSession([
          storedChangeEntry({ touchedFiles: ['docs/forbidden/output.md'] }),
          changeCycleEntry(cleanCycle()),
        ]),
      } as never,
    );
    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'out-of-scope',
    );
  } finally {
    await rm(dirtyDir, { recursive: true, force: true });
  }

  const cleanDir = await mkdtemp(join(tmpdir(), 'gsd-finalize-build-oos-ok-'));
  try {
    await writeFinalizeDocs(cleanDir);
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: cleanDir,
        sessionManager: entriesSession([
          storedChangeEntry({ touchedFiles: ['src/example.ts'] }),
          changeCycleEntry(cleanCycle()),
        ]),
      } as never,
    );
    assert.strictEqual((result.details as { ok: boolean }).ok, true);
  } finally {
    await rm(cleanDir, { recursive: true, force: true });
  }
});

test('toolFinalizeBuild: ties out-of-scope check to the reviewed iteration', async () => {
  const dirtyDir = await mkdtemp(
    join(tmpdir(), 'gsd-finalize-build-oos-bypass-'),
  );
  try {
    await writeFinalizeDocs(dirtyDir);
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: dirtyDir,
        sessionManager: entriesSession([
          storedChangeEntry({
            iteration: 1,
            touchedFiles: ['docs/forbidden/reviewed.md'],
          }),
          changeCycleEntry(cleanCycle({ iteration: 1 })),
          storedChangeEntry({
            id: 'later-clean-change',
            iteration: 2,
            touchedFiles: ['src/example.ts'],
          }),
        ]),
      } as never,
    );
    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'out-of-scope',
    );
  } finally {
    await rm(dirtyDir, { recursive: true, force: true });
  }

  const cleanDir = await mkdtemp(
    join(tmpdir(), 'gsd-finalize-build-oos-reviewed-clean-'),
  );
  try {
    await writeFinalizeDocs(cleanDir);
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: cleanDir,
        sessionManager: entriesSession([
          storedChangeEntry({ iteration: 1, touchedFiles: ['src/example.ts'] }),
          changeCycleEntry(cleanCycle({ iteration: 1 })),
          storedChangeEntry({
            id: 'later-dirty-change',
            iteration: 2,
            touchedFiles: ['docs/forbidden/unreviewed.md'],
          }),
        ]),
      } as never,
    );
    assert.strictEqual((result.details as { ok: boolean }).ok, true);
  } finally {
    await rm(cleanDir, { recursive: true, force: true });
  }
});

test('toolFinalizeBuild: refuses masked same-iteration reviewed candidate out-of-scope files', async () => {
  const reviewedChange = `${CHANGE_DOC}\n\nReviewed dirty bytes.`;
  const unreviewedChange = `${CHANGE_DOC}\n\nUnreviewed clean bytes.`;
  const dir = await mkdtemp(
    join(tmpdir(), 'gsd-finalize-build-oos-same-iter-mask-'),
  );
  try {
    await writeFinalizeDocs(dir);
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: entriesSession([
          storedChangeEntry({
            id: 'reviewed-dirty-change',
            iteration: 1,
            change: reviewedChange,
            touchedFiles: ['docs/forbidden/reviewed.md'],
          }),
          storedChangeEntry({
            id: 'unreviewed-clean-change',
            iteration: 1,
            change: unreviewedChange,
            touchedFiles: ['src/example.ts'],
          }),
          changeCycleEntry(
            cleanCycle({ iteration: 1, change: reviewedChange }),
          ),
        ]),
      } as never,
    );
    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'out-of-scope',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizeBuild: unions touched files for same-iteration reviewed duplicate bytes', async () => {
  const reviewedChange = `${CHANGE_DOC}\n\nReviewed duplicate bytes.`;
  const dir = await mkdtemp(
    join(tmpdir(), 'gsd-finalize-build-oos-same-iter-union-'),
  );
  try {
    await writeFinalizeDocs(dir);
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: entriesSession([
          storedChangeEntry({
            id: 'reviewed-dirty-change',
            iteration: 1,
            change: reviewedChange,
            touchedFiles: ['docs/forbidden/reviewed.md'],
          }),
          storedChangeEntry({
            id: 'reviewed-clean-change',
            iteration: 1,
            change: reviewedChange,
            touchedFiles: ['src/example.ts'],
          }),
          changeCycleEntry(
            cleanCycle({ iteration: 1, change: reviewedChange }),
          ),
        ]),
      } as never,
    );
    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'out-of-scope',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizeBuild: fails closed when latest reviewed bytes have no stored candidate', async () => {
  const reviewedChange = `${CHANGE_DOC}\n\nReviewed bytes.`;
  const storedChangeBytes = `${CHANGE_DOC}\n\nDifferent stored bytes.`;
  const dir = await mkdtemp(
    join(tmpdir(), 'gsd-finalize-build-missing-stored-change-'),
  );
  try {
    await writeFinalizeDocs(dir);
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: entriesSession([
          storedChangeEntry({
            iteration: 1,
            change: storedChangeBytes,
            touchedFiles: ['src/example.ts'],
          }),
          changeCycleEntry(
            cleanCycle({ iteration: 1, change: reviewedChange }),
          ),
        ]),
      } as never,
    );
    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'missing-stored-change',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizeBuild: refuses slice-level requirement mismatches', async () => {
  const unknownDir = await mkdtemp(
    join(tmpdir(), 'gsd-finalize-build-slice-req-unknown-'),
  );
  try {
    await writeFinalizeDocs(unknownDir, {
      plan: defaultPlan({
        reqIds: ['REQ-01'],
        slices: [
          {
            ...defaultPlan().slices[0]!,
            reqIds: ['REQ-404'],
          },
        ],
      }),
    });
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: unknownDir,
        sessionManager: entriesSession([
          storedChangeEntry({ touchedFiles: ['src/example.ts'] }),
          changeCycleEntry(cleanCycle()),
        ]),
      } as never,
    );
    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'unresolved-req',
    );
  } finally {
    await rm(unknownDir, { recursive: true, force: true });
  }

  const unclaimedDir = await mkdtemp(
    join(tmpdir(), 'gsd-finalize-build-slice-req-unclaimed-'),
  );
  try {
    await writeFinalizeDocs(unclaimedDir, {
      plan: defaultPlan({
        reqIds: ['REQ-01'],
        slices: [
          {
            ...defaultPlan().slices[0]!,
            reqIds: ['REQ-02'],
          },
        ],
      }),
      requirements: defaultRequirements([
        { id: 'REQ-01', text: 'Implement scoped work.' },
        { id: 'REQ-02', text: 'Additional existing requirement.' },
      ]),
    });
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: unclaimedDir,
        sessionManager: entriesSession([
          storedChangeEntry({ touchedFiles: ['src/example.ts'] }),
          changeCycleEntry(cleanCycle()),
        ]),
      } as never,
    );
    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'slice-req-not-claimed',
    );
  } finally {
    await rm(unclaimedDir, { recursive: true, force: true });
  }
});

test('toolFinalizeBuild: closure evidence uses latest slice result per slice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-build-slice-result-'));
  try {
    await writeFinalizeDocs(dir);
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: entriesSession([
          storedChangeEntry({ touchedFiles: ['src/example.ts'] }),
          changeCycleEntry(cleanCycle()),
          sliceResultEntry('old-base..old-head'),
          sliceResultEntry('new-base..new-head'),
        ]),
      } as never,
    );
    assert.strictEqual((result.details as { ok: boolean }).ok, true);
    const requirements = parseRequirementsDoc(
      await readFile(join(dir, 'docs', 'REQUIREMENTS.md'), 'utf8'),
    );
    assert.strictEqual(
      requirements.requirements[0]?.evidence,
      'new-base..new-head',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizeBuild: verify none closes requirements with null command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-build-verify-none-'));
  try {
    await writeFinalizeDocs(dir, {
      plan: defaultPlan({ verify: 'none' }),
    });
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: entriesSession([
          storedChangeEntry({ touchedFiles: ['src/example.ts'] }),
          changeCycleEntry(cleanCycle({ verifyCommand: null })),
        ]),
      } as never,
    );
    assert.strictEqual((result.details as { ok: boolean }).ok, true);
    const requirements = parseRequirementsDoc(
      await readFile(join(dir, 'docs', 'REQUIREMENTS.md'), 'utf8'),
    );
    assert.deepStrictEqual(requirements.requirements[0]?.verify, {
      command: null,
      ok: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizeBuild: absent plan verify uses latest accepted cycle command', async () => {
  const dir = await mkdtemp(
    join(tmpdir(), 'gsd-finalize-build-verify-latest-'),
  );
  try {
    const planWithoutVerify = { ...defaultPlan() };
    delete planWithoutVerify.verify;
    await writeFinalizeDocs(dir, { plan: planWithoutVerify });
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: entriesSession([
          storedChangeEntry({
            id: 'old-stored-change',
            iteration: 1,
            touchedFiles: ['src/example.ts'],
          }),
          changeCycleEntry(
            cleanCycle({ iteration: 1, verifyCommand: 'npm test --old' }),
          ),
          storedChangeEntry({
            id: 'new-stored-change',
            iteration: 2,
            touchedFiles: ['src/example.ts'],
          }),
          changeCycleEntry(
            cleanCycle({ iteration: 2, verifyCommand: 'npm run verify:new' }),
          ),
        ]),
      } as never,
    );
    assert.strictEqual((result.details as { ok: boolean }).ok, true);
    const requirements = parseRequirementsDoc(
      await readFile(join(dir, 'docs', 'REQUIREMENTS.md'), 'utf8'),
    );
    assert.deepStrictEqual(requirements.requirements[0]?.verify, {
      command: 'npm run verify:new',
      ok: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizeBuild: refuses a plan slice with no persisted cycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-build-missing-'));
  try {
    await writeFinalizeDocs(dir, {
      plan: defaultPlan({
        slices: [
          defaultPlan().slices[0]!,
          {
            n: 2,
            title: 'Second slice',
            reqIds: ['REQ-01'],
            consumes: [],
            produces: [],
          },
        ],
      }),
    });
    const tool = toolFinalizeBuild({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: entriesSession([changeCycleEntry(cleanCycle())]),
      } as never,
    );
    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'missing-cycle',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function listTmpFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const name of await readdir(current)) {
      const path = join(current, name);
      const s = await stat(path);
      if (s.isDirectory()) {
        await walk(path);
      } else if (name.endsWith('.tmp')) {
        out.push(path);
      }
    }
  }
  await walk(dir);
  return out;
}

test('toolFinalizeBuild: staging failure leaves existing docs untouched and no temp files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-build-crash-'));
  try {
    await writeFinalizeDocs(dir);
    const summaryPath = join(
      dir,
      'docs',
      'phases',
      '01-planning-artifacts',
      `${TEST_PLAN_ID}-SUMMARY.md`,
    );
    await writeFile(summaryPath, 'existing summary\n', 'utf8');
    const beforeState = await readFile(join(dir, 'docs', 'STATE.md'), 'utf8');
    const beforeRequirements = await readFile(
      join(dir, 'docs', 'REQUIREMENTS.md'),
      'utf8',
    );
    const beforeSummary = await readFile(summaryPath, 'utf8');
    let writeCount = 0;
    const tool = toolFinalizeBuild(
      { appendEntry: () => {} },
      {
        writeFile: async (path, content, encoding) => {
          writeCount += 1;
          if (writeCount === 2) throw new Error('forced staging failure');
          await writeFile(path, content, encoding);
        },
      },
    );

    await assert.rejects(() =>
      tool.execute(
        '1',
        { planId: TEST_PLAN_ID, summary: 'done', deliverables: [] },
        undefined,
        undefined,
        {
          cwd: dir,
          sessionManager: entriesSession([
            storedChangeEntry({ touchedFiles: ['src/example.ts'] }),
            changeCycleEntry(cleanCycle()),
          ]),
        } as never,
      ),
    );
    assert.strictEqual(
      await readFile(join(dir, 'docs', 'STATE.md'), 'utf8'),
      beforeState,
    );
    assert.strictEqual(
      await readFile(join(dir, 'docs', 'REQUIREMENTS.md'), 'utf8'),
      beforeRequirements,
    );
    assert.strictEqual(await readFile(summaryPath, 'utf8'), beforeSummary);
    assert.deepStrictEqual(await listTmpFiles(join(dir, 'docs')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deriveCommitRange: handles empty, single, and multi ranges', () => {
  assert.strictEqual(deriveCommitRange([]), undefined);
  assert.strictEqual(deriveCommitRange(['abc..def']), 'abc..def');
  assert.strictEqual(deriveCommitRange(['aaa..bbb', 'ccc..ddd']), 'aaa..ddd');
  assert.strictEqual(
    deriveCommitRange(['aaa..bbb', 'not-a-range']),
    'aaa..bbb, not-a-range',
  );
});

test('pathMatchesOutOfScope: covers exact, dir-prefix, glob matches and non-matches', () => {
  assert.strictEqual(
    pathMatchesOutOfScope('./docs/STATE.md', ['docs/STATE.md']),
    true,
  );
  assert.strictEqual(pathMatchesOutOfScope('docs/STATE.md', ['docs/']), true);
  assert.strictEqual(pathMatchesOutOfScope('docs/STATE.md', ['docs']), true);
  assert.strictEqual(pathMatchesOutOfScope('src/foo.ts', ['src/*.ts']), true);
  assert.strictEqual(
    pathMatchesOutOfScope('phases/01/foo/NN-MM-SUMMARY.md', [
      'phases/**/NN-MM-SUMMARY.md',
    ]),
    true,
  );
  assert.strictEqual(pathMatchesOutOfScope('src/foo.tsx', ['src/*.ts']), false);
  assert.strictEqual(
    pathMatchesOutOfScope('src/nested/foo.ts', ['src/*.ts']),
    false,
  );
  assert.strictEqual(
    pathMatchesOutOfScope('src/build-tools.ts', ['docs/']),
    false,
  );
  assert.strictEqual(
    pathMatchesOutOfScope('a/b/c/d/e/f/g/deep.md', ['**/**/*.md']),
    true,
  );
  assert.strictEqual(
    pathMatchesOutOfScope('a/b/c/d/e/f/g/deep.ts', ['**/**/*.md']),
    false,
  );
});
