import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  pathMatchesOutOfScope,
  toolStoreCandidateChange,
  toolValidateChange,
} from './build-tools.js';
import { planFingerprint } from './plan-tools.js';
import {
  ENTRY,
  type GsdChangeReviewCycle,
  type GsdReviewResult,
  type GsdStoredCandidateChange,
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
  } = {},
): GsdChangeReviewCycle {
  const verify =
    options.verifyOk === false
      ? { command: 'npm run verify', exitCode: 1, ok: false }
      : { command: 'npm run verify', exitCode: 0, ok: true };
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
