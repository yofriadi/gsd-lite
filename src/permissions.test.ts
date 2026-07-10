/**
 * Phase 5 structural test for the `/build` protected-doc permission guard.
 *
 * This asserts the shipped `@gotgenes/pi-permission-system` project config
 * (`.pi/extensions/pi-permission-system/config.json`) denies direct `write`
 * and `edit` to the protected living docs and SUMMARY artifacts while leaving
 * source paths writable and protected docs readable. Those protected docs are
 * written only by the sanctioned finalize/init tools, which use `node:fs`
 * (`writeFile` + `rename`) rather than the agent `write`/`edit` tools, so a
 * tool-surface deny blocks the LLM's direct mutation without blocking the
 * gated writers.
 *
 * The live permission hook is loaded by Pi from the global agent npm dir and
 * is not resolvable from this repo (it is wired as a peer dependency in
 * Phase 7). Rather than import the unresolvable package, this test ships a
 * FAITHFUL re-implementation of the matcher + resolver whose semantics are
 * copied from the installed package source:
 *
 *   @gotgenes/pi-permission-system v20.3.0, src/wildcard-matcher.ts
 *     - a pattern compiles to a regex: escape regex metachars, split on `*`
 *       and join the escaped parts with `.*`, replace an escaped `\?` with `.`
 *       per part, anchor `^...$`, and use the `s` (dotAll) flag so `*` matches
 *       ACROSS `/`. `**` is NOT a distinct globstar — a single `*` already
 *       recurses across path separators.
 *     - resolution is LAST-MATCH-WINS (`Array.prototype.findLast`), so a
 *       catch-all `"*"` must come first and specific overrides after.
 *
 * If the real matcher semantics ever change, this replica (and the shipped
 * config's reliance on them) must be revisited.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = process.cwd();

const CONFIG_PATH = join(
  REPO_ROOT,
  '.pi',
  'extensions',
  'pi-permission-system',
  'config.json',
);

type PermissionAction = 'allow' | 'deny' | 'ask';
type DenyWithReason = { action: 'deny'; reason?: string };
type PatternValue = PermissionAction | DenyWithReason;
type PermissionSurface = PermissionAction | Record<string, PatternValue>;
interface PermissionConfig {
  permission: Record<string, PermissionSurface>;
}

function loadConfig(): PermissionConfig {
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw) as PermissionConfig;
}

// --- Faithful matcher replica (see the file header for the cited source). ---

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePattern(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => escapeRegExp(part).replaceAll('\\?', '.'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 's');
}

function wildcardMatch(pattern: string, value: string): boolean {
  return compilePattern(pattern).test(value);
}

function normalizeAction(value: PatternValue): PermissionAction {
  if (typeof value === 'string') return value;
  return value.action;
}

/**
 * Resolve the decision for (tool, path) the way the real resolver does:
 * a string surface is a catch-all; an object surface picks the LAST matching
 * pattern; with no match, fall back to `permission["*"]` (default `ask`).
 */
function resolve(
  config: PermissionConfig,
  tool: string,
  path: string,
): PermissionAction {
  const surface = config.permission[tool];
  if (surface !== undefined) {
    if (typeof surface === 'string') return surface;
    const entries = Object.entries(surface);
    // Last-match-wins: mirror the real resolver's `findLast` by scanning in
    // reverse and taking the first (i.e. last-declared) matching pattern.
    for (let i = entries.length - 1; i >= 0; i--) {
      const [pattern, value] = entries[i];
      if (wildcardMatch(pattern, path)) return normalizeAction(value);
    }
  }
  const fallback = config.permission['*'];
  if (typeof fallback === 'string') return fallback;
  return 'ask';
}

const PROTECTED_DOCS = [
  'docs/PROJECT.md',
  'docs/REQUIREMENTS.md',
  'docs/ROADMAP.md',
  'docs/STATE.md',
  'docs/phases/05-runtime/05-01-SUMMARY.md',
];

const SOURCE_PATHS = [
  'src/build-tools.ts',
  'index.ts',
  'prompts/builder-slice.md',
  // A PLAN.md is not a SUMMARY.md — proves the SUMMARY glob is not over-broad.
  'docs/phases/05-runtime/05-01-PLAN.md',
];

const MUTATING_TOOLS = ['write', 'edit'] as const;

test('config: write and edit surfaces are pattern maps with an allow catch-all', () => {
  const config = loadConfig();
  for (const tool of MUTATING_TOOLS) {
    const surface = config.permission[tool];
    assert.ok(
      surface !== null && typeof surface === 'object',
      `${tool} surface must be a pattern map`,
    );
    const map = surface as Record<string, PatternValue>;
    assert.strictEqual(
      normalizeAction(map['*']),
      'allow',
      `${tool} must allow source paths by default`,
    );
    for (const doc of [
      'docs/PROJECT.md',
      'docs/REQUIREMENTS.md',
      'docs/ROADMAP.md',
      'docs/STATE.md',
      'docs/phases/*-SUMMARY.md',
    ]) {
      assert.ok(
        map[doc] !== undefined,
        `${tool} must declare a rule for ${doc}`,
      );
      assert.strictEqual(
        normalizeAction(map[doc]),
        'deny',
        `${tool} must deny ${doc}`,
      );
    }
  }
});

test('config: read/grep/find/ls are allowed so the executor can read protected docs', () => {
  const config = loadConfig();
  for (const tool of ['read', 'grep', 'find', 'ls']) {
    assert.strictEqual(
      config.permission[tool],
      'allow',
      `${tool} must be allowed`,
    );
  }
});

test('guard: write/edit to every protected doc resolves to deny', () => {
  const config = loadConfig();
  for (const tool of MUTATING_TOOLS) {
    for (const doc of PROTECTED_DOCS) {
      assert.strictEqual(
        resolve(config, tool, doc),
        'deny',
        `${tool} ${doc} must be denied`,
      );
    }
  }
});

test('guard: write/edit to source paths resolves to allow (clean control)', () => {
  const config = loadConfig();
  for (const tool of MUTATING_TOOLS) {
    for (const path of SOURCE_PATHS) {
      assert.strictEqual(
        resolve(config, tool, path),
        'allow',
        `${tool} ${path} must be allowed`,
      );
    }
  }
});

test('guard: read of a protected doc is not denied', () => {
  const config = loadConfig();
  assert.notStrictEqual(resolve(config, 'read', 'docs/STATE.md'), 'deny');
});

test('matcher: SUMMARY glob recurses across "/" but does not match PLAN.md', () => {
  const pattern = 'docs/phases/*-SUMMARY.md';
  assert.ok(
    wildcardMatch(pattern, 'docs/phases/05-runtime/05-01-SUMMARY.md'),
    'SUMMARY glob must match a nested SUMMARY path (single * recurses)',
  );
  assert.ok(
    !wildcardMatch(pattern, 'docs/phases/05-runtime/05-01-PLAN.md'),
    'SUMMARY glob must not match a PLAN path',
  );
});
