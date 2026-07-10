/**
 * Phase 4 structural tests for the in-repo review subagents.
 *
 * These are static assertions over the shipped markdown under
 * `.pi/agent/agents/` and the authored prompt bodies under `prompts/`, not
 * live subagent runs:
 *
 *  - Read-only tool policy: both reviewers declare only read-only tools,
 *    `inherit_context: false`, and a permission block that denies `write`,
 *    `edit`, and `external_directory`; descriptions must be trigger-only.
 *  - Output-contract round-trip: a canned example blob for each reviewer
 *    parses cleanly through `parseReviewResult`, and a malformed blob is
 *    rejected — proving the two reviewers share one parser.
 *  - Prompt/agent byte budget: each authored body stays under a per-file cap
 *    so the reactive heading-map read is backstopped by a proactive budget.
 */

import assert from 'node:assert';
import { readFileSync, statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { ParseError, parseReviewResult } from './parse.js';

const REPO_ROOT = process.cwd();

const REVIEWER_AGENTS = ['plan-reviewer', 'code-reviewer'] as const;

/** Per-file byte cap for authored prompt/agent bodies (proactive budget). */
const BYTE_CAP = 38 * 1024;

/** Authored bodies subject to the byte budget. `builder-slice.md` is included once it exists. */
const BUDGETED_BODIES = [
  join('prompts', 'planner-starter.md'),
  join('prompts', 'init-starter.md'),
  join('prompts', 'builder-slice.md'),
  join('.pi', 'agent', 'agents', 'plan-reviewer.md'),
  join('.pi', 'agent', 'agents', 'code-reviewer.md'),
];

/** Read-only tools a reviewer may declare — nothing that can mutate. */
const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

interface Frontmatter {
  scalars: Record<string, string>;
  /** The `tools:` list, comma-split. */
  tools: string[];
  /** Flattened `permission:` block entries, e.g. `write` -> `deny`. */
  permission: Record<string, string>;
}

function agentPath(name: string): string {
  return join(REPO_ROOT, '.pi', 'agent', 'agents', `${name}.md`);
}

/** Minimal frontmatter reader for the simple key: value + nested `permission:` shape. */
function parseFrontmatter(markdown: string): Frontmatter {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, 'agent markdown must open with a --- frontmatter block');
  const lines = match[1].split('\n');

  const scalars: Record<string, string> = {};
  const permission: Record<string, string> = {};
  let inPermission = false;

  for (const line of lines) {
    if (line.trim() === '') continue;
    const indented = /^\s+/.test(line);

    if (!indented) {
      inPermission = false;
      const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (!kv) continue;
      const [, key, value] = kv;
      if (key === 'permission') {
        inPermission = true;
        continue;
      }
      scalars[key] = value.trim();
      continue;
    }

    if (inPermission) {
      const kv = line.match(/^\s+"?([A-Za-z_*]+)"?:\s*(.*)$/);
      if (kv) permission[kv[1]] = kv[2].trim();
    }
  }

  const toolsRaw = scalars.tools ?? '';
  const tools = toolsRaw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  return { scalars, tools, permission };
}

for (const name of REVIEWER_AGENTS) {
  test(`${name}: declares only read-only tools`, () => {
    const fm = parseFrontmatter(readFileSync(agentPath(name), 'utf8'));
    assert.ok(fm.tools.length > 0, 'reviewer must declare a tools list');
    for (const tool of fm.tools) {
      assert.ok(
        READ_ONLY_TOOLS.has(tool),
        `${name} declares non-read-only tool: ${tool}`,
      );
    }
  });

  test(`${name}: sets inherit_context false`, () => {
    const fm = parseFrontmatter(readFileSync(agentPath(name), 'utf8'));
    assert.strictEqual(
      fm.scalars.inherit_context,
      'false',
      `${name} must declare inherit_context: false`,
    );
  });

  test(`${name}: permission block denies write, edit, and external_directory`, () => {
    const fm = parseFrontmatter(readFileSync(agentPath(name), 'utf8'));
    assert.strictEqual(fm.permission.write, 'deny', `${name} must deny write`);
    assert.strictEqual(fm.permission.edit, 'deny', `${name} must deny edit`);
    assert.strictEqual(
      fm.permission.external_directory,
      'deny',
      `${name} must deny external_directory`,
    );
  });

  test(`${name}: description is trigger-only, not a workflow summary`, () => {
    const fm = parseFrontmatter(readFileSync(agentPath(name), 'utf8'));
    const description = fm.scalars.description ?? '';
    assert.ok(description.length > 0, `${name} must have a description`);
    // A trigger-only description names WHAT the agent is / WHEN to invoke it,
    // not a compressed sequence of workflow steps. Reject step-listing verbs
    // and enumerations that leak the body's workflow into metadata.
    assert.ok(
      !/\b(then|first|next|finally|step\s*\d)\b/i.test(description),
      `${name} description must not summarize workflow steps: "${description}"`,
    );
    assert.ok(
      description.length <= 120,
      `${name} description should stay a short trigger, not a workflow summary`,
    );
  });
}

test('code-reviewer: example review blob round-trips through parseReviewResult', () => {
  const blob = [
    'Reviewed the slice diff against the claimed REQ ids.',
    '```json',
    JSON.stringify({
      blockers: [
        {
          issue: 'REQ-03 handler never validates the empty-list case',
          fix: 'add a guard returning [] before the map',
        },
      ],
      warnings: [{ issue: 'helper is only used once; consider inlining' }],
      nitpicks: [{ issue: 'prefer const over let for the accumulator' }],
      summary: 'One blocker: REQ-03 edge case unhandled.',
    }),
    '```',
  ].join('\n');
  const r = parseReviewResult(blob);
  assert.strictEqual(r.blockers.length, 1);
  assert.strictEqual(
    r.blockers[0].issue,
    'REQ-03 handler never validates the empty-list case',
  );
  assert.strictEqual(r.warnings.length, 1);
  assert.strictEqual(r.summary, 'One blocker: REQ-03 edge case unhandled.');
});

test('plan-reviewer: example review blob round-trips through parseReviewResult', () => {
  const blob = [
    '```json',
    JSON.stringify({
      blockers: [],
      warnings: [{ issue: 'assumption about the API version is unstated' }],
      nitpicks: [],
      summary: 'Plan is sound; one assumption to make explicit.',
    }),
    '```',
  ].join('\n');
  const r = parseReviewResult(blob);
  assert.strictEqual(r.blockers.length, 0);
  assert.strictEqual(r.warnings.length, 1);
  assert.strictEqual(r.nitpicks.length, 0);
});

test('reviewers share one parser: a malformed blob is rejected', () => {
  // missing `summary`
  assert.throws(
    () =>
      parseReviewResult(
        JSON.stringify({ blockers: [], warnings: [], nitpicks: [] }),
      ),
    ParseError,
  );
  // `blockers` not an array
  assert.throws(
    () =>
      parseReviewResult(
        JSON.stringify({
          blockers: 'nope',
          warnings: [],
          nitpicks: [],
          summary: 'x',
        }),
      ),
    ParseError,
  );
});

for (const rel of BUDGETED_BODIES) {
  const abs = join(REPO_ROOT, rel);
  test(`byte budget: ${rel} stays under ${BYTE_CAP} bytes`, () => {
    if (!existsSync(abs)) {
      // builder-slice.md is authored in Phase 5; the budget applies once it exists.
      assert.ok(
        rel.endsWith('builder-slice.md'),
        `expected authored body is missing: ${rel}`,
      );
      return;
    }
    const size = statSync(abs).size;
    assert.ok(
      size <= BYTE_CAP,
      `${rel} is ${size} bytes, over the ${BYTE_CAP}-byte cap`,
    );
  });
}
