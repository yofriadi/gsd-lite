import assert from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

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
} from './types.js';

function reviewJson(review: GsdReviewResult): string {
  return ['```json', JSON.stringify(review, null, 2), '```'].join('\n');
}

function planningContextJson(): string {
  return JSON.stringify({
    objective: 'build the thing',
    constraints: ['use TypeScript'],
    nonGoals: ['rewrite the world'],
    assumptions: ['pi SDK available'],
    deferredItems: ['execution order'],
    repoFindings: ['uses node:test'],
  });
}

function contextEntry(iteration = 1) {
  return {
    customType: ENTRY.planningContext,
    data: { iteration, ...JSON.parse(planningContextJson()) },
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
      path: `.gsd-lite/candidate-plans/${id}.md`,
      plan,
    },
  };
}

const TEST_PLAN_ID = 'plan-test-id';

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

test('toolValidatePlan: metadata says plan-reviewer does review work', () => {
  const tool = toolValidatePlan({
    appendEntry: () => {},
  });

  assert.ok(tool.description?.includes('does not review the plan itself'));
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
      sessionManager: branchSessionWithPlan('Candidate plan body'),
    } as never,
  );

  assert.strictEqual(appended.length, 2);
  assert.strictEqual(appended[0]?.customType, ENTRY.planningContext);
  assert.strictEqual(appended[1]?.customType, ENTRY.planReviewCycle);
  const cycle = appended[1]?.data as GsdPlanReviewCycle;
  assert.strictEqual(cycle.ok, true);
  if (cycle.ok) {
    assert.strictEqual(cycle.status, 'clean');
    assert.strictEqual(cycle.candidatePlan, 'Candidate plan body');
    assert.deepStrictEqual(cycle.review.blockers, []);
    assert.deepStrictEqual(cycle.review.warnings, []);
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
      sessionManager: branchSessionWithPlan('Candidate plan body'),
    } as never,
  );

  assert.strictEqual(appended.length, 2);
  assert.strictEqual(appended[0]?.customType, ENTRY.planningContext);
  const cycle = appended[1]?.data as GsdPlanReviewCycle;
  assert.strictEqual(cycle.ok, false);
  if (!cycle.ok) {
    assert.strictEqual(cycle.status, 'parse');
  }
  assert.ok(firstText(result).includes('gsd-review-result'));
});

test('toolValidatePlan: non-completed status stores failed cycle', async () => {
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
      reviewOutput: 'plan-reviewer aborted upstream',
      reviewStatus: 'aborted',
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSessionWithPlan('Candidate plan body'),
    } as never,
  );

  assert.strictEqual(appended.length, 2);
  assert.strictEqual(appended[0]?.customType, ENTRY.planningContext);
  const cycle = appended[1]?.data as GsdPlanReviewCycle;
  assert.strictEqual(cycle.ok, false);
  if (!cycle.ok) {
    assert.strictEqual(cycle.status, 'aborted');
    assert.strictEqual(cycle.message, 'plan-reviewer aborted upstream');
  }
  assert.ok(firstText(result).includes('aborted'));
});

test('toolFinalizePlan: refuses without clean review', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const tool = toolFinalizePlan({
      appendEntry: (customType, data) => {
        appended.push({ customType, data });
      },
    });
    const result = await tool.execute(
      '1',
      { markdown: '# Plan' },
      undefined,
      undefined,
      { cwd: dir, sessionManager: branchSession() } as never,
    );

    assert.strictEqual(appended.length, 0);
    assert.ok(firstText(result).includes('no persisted validate-plan'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: writes PLANS.md only for matching clean review', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const reviewedPlan = '# Plan\n- step 1';
    const tool = toolFinalizePlan({
      appendEntry: (customType, data) => {
        appended.push({ customType, data });
      },
    });
    const result = await tool.execute(
      '1',
      { markdown: reviewedPlan },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: branchSession([
          contextEntry(2),
          {
            customType: ENTRY.planReviewCycle,
            data: {
              iteration: 2,
              ok: true,
              candidatePlan: reviewedPlan,
              raw: reviewJson({
                blockers: [],
                warnings: [],
                nitpicks: [],
                summary: 'ready',
              }),
              review: {
                blockers: [],
                warnings: [],
                nitpicks: [],
                summary: 'ready',
              },
              status: 'clean',
            } satisfies GsdPlanReviewCycle,
          },
        ]),
      } as never,
    );

    const disk = await readFile(join(dir, 'PLANS.md'), 'utf8');
    assert.strictEqual(disk, reviewedPlan);
    assert.strictEqual(appended.length, 1);
    assert.strictEqual(appended[0]?.customType, ENTRY.planFinalized);
    assert.ok(firstText(result).includes('PLANS.md written'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: rejects stale markdown after clean review', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const tool = toolFinalizePlan({
      appendEntry: () => {},
    });
    const result = await tool.execute(
      '1',
      { markdown: '# Changed plan' },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: branchSession([
          contextEntry(),
          {
            customType: ENTRY.planReviewCycle,
            data: {
              iteration: 1,
              ok: true,
              candidatePlan: '# Original plan',
              raw: reviewJson({
                blockers: [],
                warnings: [],
                nitpicks: [],
                summary: 'ready',
              }),
              review: {
                blockers: [],
                warnings: [],
                nitpicks: [],
                summary: 'ready',
              },
              status: 'clean',
            } satisfies GsdPlanReviewCycle,
          },
        ]),
      } as never,
    );

    assert.ok(firstText(result).includes('markdown differs'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolValidatePlan: round-trips ReviewEntry with issue and fix', async () => {
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
        blockers: [
          {
            issue: 'no refresh strategy',
            fix: 'specify token TTL and refresh path',
          },
        ],
        warnings: [{ issue: 'license unclear' }],
        nitpicks: [{ issue: 'rename foo' }],
        summary: 'one blocker, one warning',
      }),
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSessionWithPlan('# Plan'),
    } as never,
  );

  assert.strictEqual(appended.length, 2);
  assert.strictEqual(appended[0]?.customType, ENTRY.planningContext);
  const cycle = appended[1]?.data as GsdPlanReviewCycle;
  assert.ok(cycle.ok);
  if (cycle.ok) {
    assert.strictEqual(cycle.status, 'needs-revision');
    assert.deepStrictEqual(cycle.review.blockers, [
      {
        issue: 'no refresh strategy',
        fix: 'specify token TTL and refresh path',
      },
    ]);
    assert.deepStrictEqual(cycle.review.warnings, [
      { issue: 'license unclear' },
    ]);
    assert.deepStrictEqual(cycle.review.nitpicks, [{ issue: 'rename foo' }]);
  }
});

test('toolFinalizePlan: refuses when warnings exist without acceptWarnings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const reviewedPlan = '# Plan';
    const tool = toolFinalizePlan({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { markdown: reviewedPlan },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: branchSession([
          contextEntry(),
          {
            customType: ENTRY.planReviewCycle,
            data: {
              iteration: 1,
              ok: true,
              candidatePlan: reviewedPlan,
              raw: reviewJson({
                blockers: [],
                warnings: [{ issue: 'license unclear' }],
                nitpicks: [],
                summary: 'one warning',
              }),
              review: {
                blockers: [],
                warnings: [{ issue: 'license unclear' }],
                nitpicks: [],
                summary: 'one warning',
              },
              status: 'needs-revision',
            } satisfies GsdPlanReviewCycle,
          },
        ]),
      } as never,
    );

    assert.ok(firstText(result).includes('1 warning(s)'));
    assert.ok(firstText(result).includes('acceptWarnings'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: accepts warnings when acceptWarnings is true', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const reviewedPlan = '# Plan';
    const tool = toolFinalizePlan({
      appendEntry: (customType, data) => {
        appended.push({ customType, data });
      },
    });
    const result = await tool.execute(
      '1',
      { markdown: reviewedPlan, acceptWarnings: true },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: branchSession([
          {
            customType: ENTRY.planReviewCycle,
            data: {
              iteration: 1,
              ok: true,
              candidatePlan: reviewedPlan,
              raw: reviewJson({
                blockers: [],
                warnings: [{ issue: 'license unclear' }, { issue: 'wording' }],
                nitpicks: [],
                summary: 'two warnings',
              }),
              review: {
                blockers: [],
                warnings: [{ issue: 'license unclear' }, { issue: 'wording' }],
                nitpicks: [],
                summary: 'two warnings',
              },
              status: 'needs-revision',
            } satisfies GsdPlanReviewCycle,
          },
          contextEntry(),
        ]),
      } as never,
    );

    const disk = await readFile(join(dir, 'PLANS.md'), 'utf8');
    assert.strictEqual(disk, reviewedPlan);
    assert.strictEqual(appended.length, 1);
    assert.strictEqual(appended[0]?.customType, ENTRY.planFinalized);
    const finalized = appended[0]?.data as {
      iteration: number;
      path: 'PLANS.md';
      acceptedWarnings?: number;
    };
    assert.strictEqual(finalized.acceptedWarnings, 2);
    assert.ok(firstText(result).includes('2 warning(s)'));
    assert.ok(firstText(result).includes('PLANS.md written'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: never accepts blockers even with acceptWarnings', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const reviewedPlan = '# Plan';
    const tool = toolFinalizePlan({
      appendEntry: (customType, data) => {
        appended.push({ customType, data });
      },
    });
    const result = await tool.execute(
      '1',
      { markdown: reviewedPlan, acceptWarnings: true },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: branchSession([
          {
            customType: ENTRY.planReviewCycle,
            data: {
              iteration: 1,
              ok: true,
              candidatePlan: reviewedPlan,
              raw: reviewJson({
                blockers: [{ issue: 'missing verification' }],
                warnings: [],
                nitpicks: [],
                summary: 'one blocker',
              }),
              review: {
                blockers: [{ issue: 'missing verification' }],
                warnings: [],
                nitpicks: [],
                summary: 'one blocker',
              },
              status: 'needs-revision',
            } satisfies GsdPlanReviewCycle,
          },
          contextEntry(),
        ]),
      } as never,
    );

    assert.strictEqual(appended.length, 0);
    assert.ok(firstText(result).includes('blockers'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolValidatePlan: parse failure on planningContext does not persist review cycle', async () => {
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
      planningContext: 'not valid json',
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
      sessionManager: branchSessionWithPlan('# Plan'),
    } as never,
  );

  assert.strictEqual(appended.length, 0);
  assert.ok(firstText(result).includes('gsd-planning-context'));
  assert.ok(
    'details' in result && (result.details as { ok: boolean }).ok === false,
  );
});

test('toolFinalizePlan: refuses when no planning context is captured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const tool = toolFinalizePlan({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { markdown: '# Plan' },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: branchSession([
          {
            customType: ENTRY.planReviewCycle,
            data: {
              iteration: 1,
              ok: true,
              candidatePlan: '# Plan',
              raw: reviewJson({
                blockers: [],
                warnings: [],
                nitpicks: [],
                summary: 'ready',
              }),
              review: {
                blockers: [],
                warnings: [],
                nitpicks: [],
                summary: 'ready',
              },
              status: 'clean',
            } satisfies GsdPlanReviewCycle,
          },
        ]),
      } as never,
    );

    assert.ok(firstText(result).includes('no planning context'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: refuses when planning context is stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-'));
  try {
    const tool = toolFinalizePlan({ appendEntry: () => {} });
    const result = await tool.execute(
      '1',
      { markdown: '# Plan v2' },
      undefined,
      undefined,
      {
        cwd: dir,
        sessionManager: branchSession([
          contextEntry(1),
          {
            customType: ENTRY.planReviewCycle,
            data: {
              iteration: 2,
              ok: true,
              candidatePlan: '# Plan v2',
              raw: reviewJson({
                blockers: [],
                warnings: [],
                nitpicks: [],
                summary: 'ready',
              }),
              review: {
                blockers: [],
                warnings: [],
                nitpicks: [],
                summary: 'ready',
              },
              status: 'clean',
            } satisfies GsdPlanReviewCycle,
          },
        ]),
      } as never,
    );

    assert.ok(firstText(result).includes('latest review cycle'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolValidatePlan: refuses when planningContext drifts from pinned iteration 1', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const tool = toolValidatePlan({
    appendEntry: (customType, data) => {
      appended.push({ customType, data });
    },
  });
  // First call pins the context at iteration 1.
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
      sessionManager: branchSessionWithPlan('# Plan'),
    } as never,
  );
  // Second call re-supplies a context whose objective has narrowed. The
  // session now has iteration-1's stored plan plus the appended context, so
  // we extend it with an iteration-2 stored plan.
  const drifted = JSON.parse(planningContextJson());
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
        storedPlanEntry('plan-test-id-2', '# Plan v2', 2),
      ]),
    } as never,
  );

  assert.ok(firstText(result).includes('diverges from the pinned'));
  assert.ok(firstText(result).includes('contextDriftAcknowledged'));
  assert.ok(
    'details' in result && (result.details as { ok: boolean }).ok === false,
  );
  // No second review-cycle entry was persisted; only the iteration-1 cycle exists.
  const cycles = appended.filter(
    (entry) => entry.customType === ENTRY.planReviewCycle,
  );
  assert.strictEqual(cycles.length, 1);
  // No second planning-context entry was persisted either.
  const contexts = appended.filter(
    (entry) => entry.customType === ENTRY.planningContext,
  );
  assert.strictEqual(contexts.length, 1);
});

test('toolValidatePlan: accepts drifted planningContext when contextDriftAcknowledged is set', async () => {
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
      sessionManager: branchSessionWithPlan('# Plan'),
    } as never,
  );
  const drifted = JSON.parse(planningContextJson());
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
      contextDriftAcknowledged: true,
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSession([
        ...appended,
        storedPlanEntry('plan-test-id-2', '# Plan v2', 2),
      ]),
    } as never,
  );

  assert.ok(firstText(result).includes('blockers=0'));
  const cycles = appended.filter(
    (entry) => entry.customType === ENTRY.planReviewCycle,
  );
  assert.strictEqual(cycles.length, 2);
});

test('toolValidatePlan: parse failure response includes recovery hint', async () => {
  const tool = toolValidatePlan({ appendEntry: () => {} });
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
      sessionManager: branchSessionWithPlan('# Plan'),
    } as never,
  );
  assert.ok(firstText(result).includes('rerun plan-reviewer once'));
});

test('toolValidatePlan: aborted status response includes recovery hint', async () => {
  const tool = toolValidatePlan({ appendEntry: () => {} });
  const result = await tool.execute(
    '1',
    {
      candidatePlanId: TEST_PLAN_ID,
      planningContext: planningContextJson(),
      reviewOutput: 'plan-reviewer aborted upstream',
      reviewStatus: 'aborted',
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSessionWithPlan('# Plan'),
    } as never,
  );
  assert.ok(firstText(result).includes('rerun plan-reviewer once'));
});

test('planFingerprint: returns first and last non-empty trimmed lines', () => {
  const fp = planFingerprint('# Plan\n- step 1\n- step 2\n- step 3\n');
  assert.deepStrictEqual(fp, {
    firstLine: '# Plan',
    lastLine: '- step 3',
  });
});

test('planFingerprint: tolerates blank trailing lines and CRLF', () => {
  const fp = planFingerprint('\r\n# Title\r\n\r\nbody\r\n\r\n');
  assert.strictEqual(fp.firstLine, '# Title');
  assert.strictEqual(fp.lastLine, 'body');
});

test('toolValidatePlan: persists failed cycle when reviewReadFingerprint does not match stored plan', async () => {
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
        // Reviewer claims to have read a plan whose first/last non-empty
        // lines are "## Other". The stored plan starts and ends with
        // "# Plan". The fingerprint must mismatch and the cycle must be
        // refused as parse.
        reviewReadFingerprint: {
          firstLine: '## Other',
          lastLine: '## Other',
        },
      }),
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSessionWithPlan('# Plan'),
    } as never,
  );

  assert.ok(firstText(result).includes('reviewReadFingerprint'));
  const cycle = appended.find(
    (entry) => entry.customType === ENTRY.planReviewCycle,
  )?.data as GsdPlanReviewCycle;
  assert.strictEqual(cycle.ok, false);
  if (!cycle.ok) {
    assert.strictEqual(cycle.status, 'parse');
  }
});

test('toolValidatePlan: accepts cycle when reviewReadFingerprint matches stored plan', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const tool = toolValidatePlan({
    appendEntry: (customType, data) => {
      appended.push({ customType, data });
    },
  });
  const plan = '# Plan\n- step 1\n- step 2';
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
        reviewReadFingerprint: planFingerprint(plan),
      }),
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSessionWithPlan(plan),
    } as never,
  );

  assert.ok(firstText(result).includes('blockers=0'));
  const cycle = appended.find(
    (entry) => entry.customType === ENTRY.planReviewCycle,
  )?.data as GsdPlanReviewCycle;
  assert.strictEqual(cycle.ok, true);
  if (cycle.ok) {
    assert.strictEqual(cycle.status, 'clean');
    assert.deepStrictEqual(
      cycle.review.reviewReadFingerprint,
      planFingerprint(plan),
    );
  }
});

test('toolValidatePlan: absent reviewReadFingerprint is accepted (graceful degradation)', async () => {
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
      }),
    },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      sessionManager: branchSessionWithPlan('# Plan'),
    } as never,
  );

  assert.ok(firstText(result).includes('blockers=0'));
  const cycle = appended.find(
    (entry) => entry.customType === ENTRY.planReviewCycle,
  )?.data as GsdPlanReviewCycle;
  if (cycle.ok) {
    assert.strictEqual(cycle.review.reviewReadFingerprint, undefined);
  }
});

test('toolValidatePlan: refuses when candidatePlanId is unknown', async () => {
  const tool = toolValidatePlan({ appendEntry: () => {} });
  const result = await tool.execute(
    '1',
    {
      candidatePlanId: 'no-such-id',
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
    { cwd: process.cwd(), sessionManager: branchSession() } as never,
  );
  assert.ok(firstText(result).includes('no stored candidate plan'));
  assert.ok(
    'details' in result &&
      (result.details as { reason: string }).reason ===
        'unknown-candidate-plan-id',
  );
});

test('toolValidatePlan: refuses when stored plan iteration mismatches current iteration', async () => {
  const tool = toolValidatePlan({ appendEntry: () => {} });
  const result = await tool.execute(
    '1',
    {
      candidatePlanId: 'plan-test-id-3',
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
      sessionManager: branchSession([
        {
          customType: ENTRY.planReviewCycle,
          data: {
            iteration: 1,
            ok: true,
            candidatePlan: '# Prior',
            raw: reviewJson({
              blockers: [],
              warnings: [],
              nitpicks: [],
              summary: 'ready',
            }),
            review: {
              blockers: [],
              warnings: [],
              nitpicks: [],
              summary: 'ready',
            },
            status: 'clean',
          } satisfies GsdPlanReviewCycle,
        },
        storedPlanEntry('plan-test-id-3', '# Stale plan', 1),
      ]),
    } as never,
  );
  assert.ok(firstText(result).includes('prepared for iteration'));
  assert.ok(
    'details' in result &&
      (result.details as { reason: string }).reason === 'iteration-mismatch',
  );
});

test('toolStoreCandidatePlan: writes the plan file and persists a session entry', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const dir = await mkdtemp(join(tmpdir(), 'gsd-store-'));
  try {
    const tool = toolStoreCandidatePlan({
      appendEntry: (customType, data) => {
        appended.push({ customType, data });
      },
    });
    const plan = '# Stored plan\n- step 1\n- step 2';
    const result = await tool.execute('1', { plan }, undefined, undefined, {
      cwd: dir,
      sessionManager: branchSession(),
    } as never);

    assert.strictEqual(appended.length, 1);
    assert.strictEqual(appended[0]?.customType, ENTRY.storedCandidatePlan);
    const stored = appended[0]?.data as GsdStoredCandidatePlan;
    assert.strictEqual(stored.iteration, 1);
    assert.strictEqual(stored.plan, plan);
    assert.ok(stored.id.length > 0);
    assert.ok(stored.path.endsWith(`${stored.id}.md`));

    const onDisk = await readFile(join(dir, stored.path), 'utf8');
    assert.strictEqual(onDisk, plan);

    const details = result.details as {
      ok: boolean;
      id: string;
      path: string;
      iteration: number;
    };
    assert.strictEqual(details.ok, true);
    assert.strictEqual(details.id, stored.id);
    assert.strictEqual(details.iteration, 1);
    assert.ok(firstText(result).includes(stored.path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolStoreCandidatePlan: iterates with the review cycle counter', async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const dir = await mkdtemp(join(tmpdir(), 'gsd-store-'));
  try {
    const tool = toolStoreCandidatePlan({
      appendEntry: (customType, data) => {
        appended.push({ customType, data });
      },
    });
    const session = branchSession([
      {
        customType: ENTRY.planReviewCycle,
        data: {
          iteration: 1,
          ok: true,
          candidatePlan: '# Prior',
          raw: reviewJson({
            blockers: [],
            warnings: [],
            nitpicks: [],
            summary: 'ready',
          }),
          review: {
            blockers: [],
            warnings: [],
            nitpicks: [],
            summary: 'ready',
          },
          status: 'clean',
        } satisfies GsdPlanReviewCycle,
      },
    ]);
    const result = await tool.execute(
      '1',
      { plan: '# Plan v2' },
      undefined,
      undefined,
      { cwd: dir, sessionManager: session } as never,
    );
    const stored = appended[0]?.data as GsdStoredCandidatePlan;
    assert.strictEqual(stored.iteration, 2);
    const details = result.details as { iteration: number };
    assert.strictEqual(details.iteration, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: clears .gsd-lite/candidate-plans/ on successful finalize', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-cleanup-'));
  try {
    // Pre-populate the candidate-plans directory with two stale files.
    const planDir = join(dir, '.gsd-lite', 'candidate-plans');
    const { mkdir: mkdirFs, writeFile: writeFileFs } =
      await import('node:fs/promises');
    await mkdirFs(planDir, { recursive: true });
    await writeFileFs(join(planDir, 'stale-1.md'), '# stale 1', 'utf8');
    await writeFileFs(join(planDir, 'stale-2.md'), '# stale 2', 'utf8');
    await writeFileFs(join(planDir, '.DS_Store'), '', 'utf8');

    const reviewedPlan = '# Final plan';
    const tool = toolFinalizePlan({ appendEntry: () => {} });
    await tool.execute('1', { markdown: reviewedPlan }, undefined, undefined, {
      cwd: dir,
      sessionManager: branchSession([
        {
          customType: ENTRY.planFinalized,
          data: {
            iteration: 0,
            path: 'PLANS.md',
          } satisfies GsdPlanFinalized,
        },
        {
          customType: ENTRY.planReviewCycle,
          data: {
            iteration: 1,
            ok: true,
            candidatePlan: reviewedPlan,
            raw: reviewJson({
              blockers: [],
              warnings: [],
              nitpicks: [],
              summary: 'ready',
            }),
            review: {
              blockers: [],
              warnings: [],
              nitpicks: [],
              summary: 'ready',
            },
            status: 'clean',
          } satisfies GsdPlanReviewCycle,
        },
        {
          customType: ENTRY.planningContext,
          data: { iteration: 1, ...JSON.parse(planningContextJson()) },
        },
      ]),
    } as never);

    // Both stale files (and the non-.md junk) should be gone. Use stat to
    // confirm the directory itself was also removed.
    const { stat: statFs } = await import('node:fs/promises');
    await assert.rejects(
      () => statFs(planDir),
      (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
      'candidate-plans directory should be removed after successful finalize',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolFinalizePlan: does not clean up .gsd-lite/candidate-plans/ when finalize fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-finalize-no-cleanup-'));
  try {
    const { mkdir: mkdirFs, writeFile: writeFileFs } =
      await import('node:fs/promises');
    const planDir = join(dir, '.gsd-lite', 'candidate-plans');
    await mkdirFs(planDir, { recursive: true });
    await writeFileFs(join(planDir, 'keep-me.md'), '# keep', 'utf8');

    const tool = toolFinalizePlan({ appendEntry: () => {} });
    // No persisted review cycle → finalize refuses → no cleanup.
    await tool.execute('1', { markdown: '# anything' }, undefined, undefined, {
      cwd: dir,
      sessionManager: branchSession(),
    } as never);

    const { readdir: readdirFs } = await import('node:fs/promises');
    const remaining = await readdirFs(planDir);
    assert.deepStrictEqual(remaining, ['keep-me.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
