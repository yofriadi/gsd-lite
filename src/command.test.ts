/**
 * Tests for the /gsd-plan command: it enables the planning/subagent tool
 * surface, avoids duplicate grilling prompt injection, and references
 * custom subagents in the starter prompt.
 */

import assert from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildStarterPrompt,
  cmdGsdPlan,
  planningToolNames,
} from './command.js';

test('buildStarterPrompt: does not prepend duplicate grilling skill text', async () => {
  const prompt = await buildStarterPrompt('solve the thing');
  assert.ok(!prompt.includes('## Grilling Instructions'));
  assert.ok(!prompt.includes('Interview me relentlessly about every aspect'));
});

test('buildStarterPrompt: encodes the loop-integrity improvements', async () => {
  const prompt = await buildStarterPrompt('solve the thing');
  // #5 planning context pinning
  assert.ok(prompt.includes('pinned at iteration 1'));
  assert.ok(prompt.includes('contextDriftAcknowledged'));
  // #6 single-source-of-truth candidate plan + read fingerprint
  assert.ok(prompt.includes('store-candidate-plan'));
  assert.ok(prompt.includes('candidatePlanId'));
  assert.ok(prompt.includes('Single source of truth'));
  assert.ok(prompt.includes('reviewReadFingerprint'));
  // cleanup of .gsd-lite/candidate-plans/
  assert.ok(prompt.includes('removes `.gsd-lite/candidate-plans/`'));
  // #7 failed-cycle recovery
  assert.ok(prompt.includes('Recovery on parse'));
  assert.ok(prompt.includes('rerun `plan-reviewer` once'));
  // #10 sensible-defaults interview rule
  assert.ok(prompt.includes('sensible default already answers'));
  // #11 sequential when dependent
  assert.ok(prompt.includes('sequentially when one question depends'));
  // #4 soft cap NOTE
  assert.ok(prompt.includes('no enforced cap on review iterations'));
});

test('buildStarterPrompt: loads from the correct package prompts directory', async () => {
  const expectedContent = await readFile(
    join(process.cwd(), 'prompts', 'planner-starter.md'),
    'utf8',
  );
  const prompt = await buildStarterPrompt('solve the thing');
  assert.ok(prompt.startsWith(expectedContent));
});

test('buildStarterPrompt: contains core workflow guidelines', async () => {
  const prompt = await buildStarterPrompt('solve the thing');
  assert.ok(prompt.includes('plan-reviewer'));
  assert.ok(prompt.includes('codebase-explorer'));
  assert.ok(prompt.includes('github-explorer'));
  assert.ok(prompt.includes('validate-plan'));
  assert.ok(prompt.includes('finalize-plan'));
  assert.ok(prompt.includes('PLANS.md'));
  assert.ok(prompt.includes('solve the thing'));
});

test('planningToolNames: enables hard-gated planning tools only', () => {
  assert.deepStrictEqual(planningToolNames(), [
    'read',
    'find',
    'grep',
    'ls',
    'ask_user_question',
    'subagent',
    'store-candidate-plan',
    'validate-plan',
    'finalize-plan',
  ]);
  assert.ok(!planningToolNames().includes('write'));
  assert.ok(!planningToolNames().includes('bash'));
});

test('cmdGsdPlan: enables planning tools and sends starter prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-cmd-'));
  let tools: string[] = [];
  let sent = '';
  let notified: { message: string; level: string } | null = null;
  try {
    const cmd = cmdGsdPlan({
      getActiveTools: () => ['read', 'subagent'],
      setActiveTools: (names) => {
        tools = names;
      },
      sendUserMessage: (message) => {
        sent = typeof message === 'string' ? message : JSON.stringify(message);
      },
    });

    await cmd.handler('build the thing', {
      cwd: dir,
      ui: {
        notify: (message: string, level: string) => {
          notified = { message, level };
        },
      },
    } as never);

    assert.deepStrictEqual(tools, planningToolNames());
    assert.strictEqual(notified, null);
    assert.ok(sent.includes('subagent'));
    assert.ok(sent.includes('plan-reviewer'));
    assert.ok(sent.includes('validate-plan'));
    assert.ok(sent.includes('finalize-plan'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cmdGsdPlan: trims the problem text before prompting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-cmd-'));
  let sent = '';
  try {
    const cmd = cmdGsdPlan({
      getActiveTools: () => ['read', 'subagent'],
      setActiveTools: () => {},
      sendUserMessage: (message) => {
        sent = typeof message === 'string' ? message : JSON.stringify(message);
      },
    });

    await cmd.handler('   build the thing   ', {
      cwd: dir,
      ui: { notify: () => {} },
    } as never);

    assert.ok(sent.includes('## Problem to Solve\nbuild the thing'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cmdGsdPlan: refuses to start without subagent tool', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-cmd-'));
  let notified: { message: string; level: string } | null = null;
  let sent = false;
  try {
    const cmd = cmdGsdPlan({
      getActiveTools: () => ['read'],
      setActiveTools: () => {
        throw new Error('should not set tools when subagent is unavailable');
      },
      sendUserMessage: () => {
        sent = true;
      },
    });

    await cmd.handler('build the thing', {
      cwd: dir,
      ui: {
        notify: (message: string, level: string) => {
          notified = { message, level };
        },
      },
    } as never);

    assert.strictEqual(sent, false);
    assert.deepStrictEqual(notified, {
      message:
        'gsd-plan requires the subagent tool from @gotgenes/pi-subagents. Enable that extension and retry.',
      level: 'error',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildStarterPrompt: instructs the agent on how to handle missing/unknown plan-reviewer', async () => {
  const prompt = await buildStarterPrompt('solve the thing');
  assert.ok(
    prompt.includes(
      'If the subagent reports an unknown agent type, stop and report that `plan-reviewer` is unavailable in the current Pi agent directory.',
    ),
  );
});
