import assert from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildToolNames,
  cmdBuild,
  earlierUnbuiltPlans,
  planFilePath,
  resolveTargetPlanId,
} from './build-command.js';
import {
  serializePlanDoc,
  serializeRoadmapBlock,
  serializeStateBlock,
} from './doc-parse.js';
import type { RoadmapDoc, StateLedger } from './types.js';

function roadmap(): RoadmapDoc {
  return {
    phases: [
      {
        id: '01',
        name: 'Core Platform',
        reqIds: ['REQ-01', 'REQ-02'],
        plans: ['01-01', '01-02'],
      },
      {
        id: '02',
        name: 'Nice Things!',
        reqIds: ['REQ-03'],
        plans: ['02-01'],
      },
    ],
  };
}

function state(overrides: Partial<StateLedger> = {}): StateLedger {
  return {
    pointer: '01-01',
    next: { command: '/build', planId: '01-02', reason: 'planned' },
    plans: [
      { id: '01-01', phase: '01', status: 'planned' },
      { id: '01-02', phase: '01', status: 'planned' },
      { id: '02-01', phase: '02', status: 'pending' },
    ],
    ...overrides,
  };
}

function fencedDoc(block: string): string {
  return ['# Doc', '', block, ''].join('\n');
}

test('buildToolNames enables source mutation plus build gate tools', () => {
  assert.deepStrictEqual(buildToolNames(), [
    'read',
    'find',
    'grep',
    'ls',
    'bash',
    'write',
    'edit',
    'subagent',
    'store-candidate-change',
    'validate-change',
  ]);
});

test('resolveTargetPlanId prefers state.next /build, then pointer, then first planned', () => {
  assert.deepStrictEqual(resolveTargetPlanId(state(), roadmap(), ''), {
    ok: true,
    planId: '01-02',
  });

  assert.deepStrictEqual(
    resolveTargetPlanId(
      state({ next: { command: '/plan', planId: null, reason: 'done' } }),
      roadmap(),
      '',
    ),
    { ok: true, planId: '01-01' },
  );

  assert.deepStrictEqual(
    resolveTargetPlanId(
      state({
        pointer: null,
        next: null,
        plans: [
          { id: '01-01', phase: '01', status: 'built' },
          { id: '01-02', phase: '01', status: 'planned' },
        ],
      }),
      { phases: [roadmap().phases[0]!] },
      '',
    ),
    { ok: true, planId: '01-02' },
  );
});

test('resolveTargetPlanId accepts explicit planId and rejects unknown plans', () => {
  assert.deepStrictEqual(resolveTargetPlanId(state(), roadmap(), ' 02-01 '), {
    ok: true,
    planId: '02-01',
  });
  assert.deepStrictEqual(resolveTargetPlanId(state(), roadmap(), '09-99'), {
    ok: false,
    reason: 'unknown-plan',
    planId: '09-99',
  });
});

test('earlierUnbuiltPlans reports roadmap-ordered gaps but does not abort', () => {
  assert.deepStrictEqual(earlierUnbuiltPlans(roadmap(), state(), '02-01'), [
    '01-01',
    '01-02',
  ]);
  assert.deepStrictEqual(
    earlierUnbuiltPlans(
      roadmap(),
      state({
        plans: [
          { id: '01-01', phase: '01', status: 'built' },
          { id: '01-02', phase: '01', status: 'planned' },
          { id: '02-01', phase: '02', status: 'planned' },
        ],
      }),
      '02-01',
    ),
    ['01-02'],
  );
});

test('planFilePath derives slugged phase paths and context path', () => {
  assert.deepStrictEqual(planFilePath(roadmap(), '02-01'), {
    phase: roadmap().phases[1],
    phaseId: '02',
    phaseDir: join('docs', 'phases', '02-nice-things'),
    planPath: join('docs', 'phases', '02-nice-things', '02-01-PLAN.md'),
    contextPath: join('docs', 'phases', '02-nice-things', '02-CONTEXT.md'),
  });
  assert.strictEqual(planFilePath(roadmap(), '09-01'), null);
});

interface FakePi {
  activeTools: string[];
  setTools: string[];
  sentUserMessages: string[];
  appended: Array<{ customType: string; data: unknown }>;
}

function fakePi(
  activeTools: string[] = ['subagent'],
): FakePi & Parameters<typeof cmdBuild>[0] {
  const pi: FakePi & Parameters<typeof cmdBuild>[0] = {
    activeTools,
    setTools: [],
    sentUserMessages: [],
    appended: [],
    getActiveTools() {
      return this.activeTools;
    },
    setActiveTools(names) {
      this.setTools = names;
    },
    sendUserMessage(content) {
      this.sentUserMessages.push(
        typeof content === 'string' ? content : JSON.stringify(content),
      );
    },
    sendMessage() {},
    appendEntry(customType, data) {
      this.appended.push({ customType, data });
    },
  };
  return pi;
}

function fakeCtx(
  cwd: string,
  notify: Array<{ message: string; type?: string }>,
  statuses: Array<{ key: string; text: string | undefined }> = [],
) {
  return {
    cwd,
    sessionManager: {
      getLeafId: () => 'parent-leaf',
      getBranch: () => [],
    },
    waitForIdle: async () => {},
    navigateTree: async () => ({ cancelled: false }),
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        statuses.push({ key, text });
      },
      notify: (message: string, type?: string) => {
        notify.push({ message, type });
      },
    },
  };
}

async function writeDocs(dir: string): Promise<void> {
  const docsDir = join(dir, 'docs');
  const phaseDir = join(docsDir, 'phases', '01-core-platform');
  await mkdir(phaseDir, { recursive: true });
  await writeFile(
    fencedPath(dir, 'docs/STATE.md'),
    fencedDoc(serializeStateBlock(state())),
    'utf8',
  );
  await writeFile(
    fencedPath(dir, 'docs/ROADMAP.md'),
    fencedDoc(serializeRoadmapBlock(roadmap())),
    'utf8',
  );
  await writeFile(
    join(phaseDir, '01-02-PLAN.md'),
    serializePlanDoc({
      id: '01-02',
      phase: '01',
      reqIds: ['REQ-02'],
      verify: 'npm run verify',
      outOfScope: ['docs/**'],
      slices: [
        {
          n: 1,
          title: 'implement feature',
          reqIds: ['REQ-02'],
          consumes: [],
          produces: ['src/feature.ts'],
        },
      ],
    }),
    'utf8',
  );
}

function fencedPath(dir: string, rel: string): string {
  return join(dir, ...rel.split('/'));
}

test('cmdBuild refuses when subagent tool is absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-build-cmd-nosubagent-'));
  const notifications: Array<{ message: string; type?: string }> = [];
  const pi = fakePi(['read']);
  try {
    const cmd = cmdBuild(pi, {
      runBuildLoop: async () => {
        throw new Error('should not run');
      },
    });
    await cmd.handler('', fakeCtx(dir, notifications) as never);

    assert.strictEqual(notifications.at(-1)?.type, 'error');
    assert.match(notifications.at(-1)?.message ?? '', /subagent/);
    assert.deepStrictEqual(pi.setTools, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cmdBuild reports missing STATE/ROADMAP and returns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-build-cmd-missing-'));
  const notifications: Array<{ message: string; type?: string }> = [];
  const pi = fakePi();
  try {
    const cmd = cmdBuild(pi, {
      runBuildLoop: async () => {
        throw new Error('should not run');
      },
    });
    await cmd.handler('', fakeCtx(dir, notifications) as never);

    assert.match(notifications.at(-1)?.message ?? '', /run \/plan first/i);
    assert.strictEqual(pi.sentUserMessages.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cmdBuild completed loop sends terminal finalize prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-build-cmd-complete-'));
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const pi = fakePi();
  try {
    await writeDocs(dir);
    const cmd = cmdBuild(pi, {
      runBuildLoop: async (deps, ctx) => {
        assert.strictEqual(ctx.planId, '01-02');
        assert.strictEqual(ctx.parentLeafId, 'parent-leaf');
        deps.renderProgress?.(['slice 1 advanced (clean)']);
        return { status: 'completed', lastSliceIndex: 0, progressLog: [] };
      },
    });
    await cmd.handler('', fakeCtx(dir, notifications, statuses) as never);

    assert.deepStrictEqual(pi.setTools, buildToolNames());
    assert.ok(
      statuses.some(
        (status) =>
          status.key === 'gpd-build-progress' &&
          status.text === 'slice 1 advanced (clean)',
      ),
    );
    assert.deepStrictEqual(statuses.slice(-2), [
      { key: 'gpd-build', text: undefined },
      { key: 'gpd-build-progress', text: undefined },
    ]);
    assert.strictEqual(pi.sentUserMessages.length, 1);
    assert.match(pi.sentUserMessages[0] ?? '', /finalize-build/);
    assert.match(pi.sentUserMessages[0] ?? '', /REQ-02/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cmdBuild refuses PLAN.md id/phase mismatches before starting loop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-build-cmd-mismatch-'));
  const notifications: Array<{ message: string; type?: string }> = [];
  const pi = fakePi();
  try {
    await writeDocs(dir);
    await writeFile(
      fencedPath(dir, 'docs/phases/01-core-platform/01-02-PLAN.md'),
      serializePlanDoc({
        id: '02-01',
        phase: '02',
        reqIds: ['REQ-02'],
        verify: 'npm run verify',
        outOfScope: ['docs/**'],
        slices: [
          {
            n: 1,
            title: 'mismatched feature',
            reqIds: ['REQ-02'],
            consumes: [],
            produces: ['src/feature.ts'],
          },
        ],
      }),
      'utf8',
    );
    const cmd = cmdBuild(pi, {
      runBuildLoop: async () => {
        throw new Error('should not run');
      },
    });
    await cmd.handler('01-02', fakeCtx(dir, notifications) as never);

    assert.strictEqual(notifications.at(-1)?.type, 'error');
    assert.match(
      notifications.at(-1)?.message ?? '',
      /does not match the resolved target 01-02/,
    );
    assert.deepStrictEqual(pi.setTools, []);
    assert.strictEqual(pi.sentUserMessages.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cmdBuild warns about earlier unbuilt plans but proceeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-build-cmd-order-'));
  const notifications: Array<{ message: string; type?: string }> = [];
  const pi = fakePi();
  try {
    await writeDocs(dir);
    const cmd = cmdBuild(pi, {
      runBuildLoop: async () => ({
        status: 'paused',
        lastSliceIndex: 0,
        progressLog: [],
      }),
    });
    await cmd.handler('01-02', fakeCtx(dir, notifications) as never);

    assert.ok(
      notifications.some((n) =>
        n.message.includes('Earlier plan(s) not built: 01-01'),
      ),
    );
    assert.deepStrictEqual(pi.setTools, buildToolNames());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
