/**
 * Tests for the /init command: it enables the PROJECT.md-only tool surface,
 * scaffolds in no-arg mode, and interviews in goal mode.
 */

import assert from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildInitPrompt, cmdInit, initToolNames } from './init-command.js';

test('initToolNames: read-only grounding + interview + the single writer', () => {
  assert.deepStrictEqual(initToolNames(), [
    'read',
    'find',
    'grep',
    'ls',
    'ask_user_question',
    'finalize-init',
  ]);
  assert.ok(!initToolNames().includes('write'));
  assert.ok(!initToolNames().includes('bash'));
  assert.ok(!initToolNames().includes('subagent'));
  assert.ok(!initToolNames().includes('scaffold-docs'));
});

test('buildInitPrompt: goal mode appends the goal text', async () => {
  const prompt = await buildInitPrompt('a note-taking app');
  assert.ok(prompt.includes('finalize-init'));
  assert.ok(prompt.includes('## Goal\na note-taking app'));
  assert.ok(!prompt.includes('_No goal provided'));
});

test('buildInitPrompt: no-arg mode emits the scaffold marker', async () => {
  const prompt = await buildInitPrompt('');
  assert.ok(prompt.includes('_No goal provided'));
  assert.ok(prompt.includes('finalize-init({})'));
});

test('buildInitPrompt: loads from the package prompts directory', async () => {
  const expected = await readFile(
    join(process.cwd(), 'prompts', 'init-starter.md'),
    'utf8',
  );
  const prompt = await buildInitPrompt('x');
  assert.ok(prompt.startsWith(expected));
});

test('cmdInit: no-arg enables init tools and sends the scaffold prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-init-cmd-'));
  let tools: string[] = [];
  let sent = '';
  try {
    const cmd = cmdInit({
      getActiveTools: () => ['read'],
      setActiveTools: (names) => {
        tools = names;
      },
      sendUserMessage: (message) => {
        sent = typeof message === 'string' ? message : JSON.stringify(message);
      },
    });

    await cmd.handler('', {
      cwd: dir,
      ui: { notify: () => {} },
    } as never);

    assert.deepStrictEqual(tools, initToolNames());
    assert.ok(sent.includes('_No goal provided'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cmdInit: goal mode trims and forwards the goal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-init-cmd-'));
  let sent = '';
  try {
    const cmd = cmdInit({
      getActiveTools: () => ['read'],
      setActiveTools: () => {},
      sendUserMessage: (message) => {
        sent = typeof message === 'string' ? message : JSON.stringify(message);
      },
    });

    await cmd.handler('   build a CLI todo app   ', {
      cwd: dir,
      ui: { notify: () => {} },
    } as never);

    assert.ok(sent.includes('## Goal\nbuild a CLI todo app'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
