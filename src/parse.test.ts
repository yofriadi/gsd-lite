import assert from 'node:assert';
import { test } from 'node:test';

import {
  ParseError,
  parsePlanningContext,
  parseReviewResult,
} from './parse.js';

test('parseReviewResult: parses fenced json block with object entries', () => {
  const r = parseReviewResult(
    [
      'some intro prose',
      '```json',
      JSON.stringify({
        blockers: [
          {
            issue: 'no graceful shutdown',
            fix: 'add SIGINT handler',
          },
        ],
        warnings: [{ issue: 'license unclear' }],
        nitpicks: [{ issue: 'wording' }],
        summary: 'mostly ready',
      }),
      '```',
      'tail prose',
    ].join('\n'),
  );
  assert.deepStrictEqual(r, {
    blockers: [
      {
        issue: 'no graceful shutdown',
        fix: 'add SIGINT handler',
      },
    ],
    warnings: [{ issue: 'license unclear' }],
    nitpicks: [{ issue: 'wording' }],
    summary: 'mostly ready',
  });
});

test('parseReviewResult: accepts legacy plain-string entries', () => {
  const r = parseReviewResult(
    JSON.stringify({
      blockers: ['b1'],
      warnings: ['w1'],
      nitpicks: ['n1'],
      summary: 'ok',
    }),
  );
  assert.deepStrictEqual(r, {
    blockers: [{ issue: 'b1' }],
    warnings: [{ issue: 'w1' }],
    nitpicks: [{ issue: 'n1' }],
    summary: 'ok',
  });
});

test('parseReviewResult: parses bare object json with no fence', () => {
  const r = parseReviewResult(
    JSON.stringify({
      blockers: [],
      warnings: [],
      nitpicks: [],
      summary: 'ready',
    }),
  );
  assert.deepStrictEqual(r, {
    blockers: [],
    warnings: [],
    nitpicks: [],
    summary: 'ready',
  });
});

test('parseReviewResult: ignores extra fields', () => {
  const r = parseReviewResult(
    JSON.stringify({
      blockers: [],
      warnings: [],
      nitpicks: [],
      summary: 'ready',
      extra: 123,
    }),
  );
  assert.deepStrictEqual(r, {
    blockers: [],
    warnings: [],
    nitpicks: [],
    summary: 'ready',
  });
});

test('parseReviewResult: rejects non-object payload', () => {
  assert.throws(() => parseReviewResult('[]'), ParseError);
});

test('parseReviewResult: rejects missing required field', () => {
  assert.throws(
    () => parseReviewResult('{"blockers":[],"warnings":[],"summary":"x"}'),
    ParseError,
  );
});

test('parseReviewResult: rejects wrong-typed summary', () => {
  assert.throws(
    () =>
      parseReviewResult(
        '{"blockers":[],"warnings":[],"nitpicks":[],"summary":1}',
      ),
    ParseError,
  );
});

test('parseReviewResult: rejects entry without issue', () => {
  assert.throws(
    () =>
      parseReviewResult(
        '{"blockers":[{"fix":"x"}],"warnings":[],"nitpicks":[],"summary":"x"}',
      ),
    ParseError,
  );
});

test('parseReviewResult: rejects entry with empty issue string', () => {
  assert.throws(
    () =>
      parseReviewResult(
        '{"blockers":[""],"warnings":[],"nitpicks":[],"summary":"x"}',
      ),
    ParseError,
  );
});

test('parseReviewResult: rejects entry with non-string fix', () => {
  assert.throws(
    () =>
      parseReviewResult(
        '{"blockers":[{"issue":"x","fix":1}],"warnings":[],"nitpicks":[],"summary":"x"}',
      ),
    ParseError,
  );
});

test('parseReviewResult: rejects entry of unsupported shape', () => {
  assert.throws(
    () =>
      parseReviewResult(
        '{"blockers":[1],"warnings":[],"nitpicks":[],"summary":"x"}',
      ),
    ParseError,
  );
});

test('parseReviewResult: accepts a valid reviewReadFingerprint', () => {
  const r = parseReviewResult(
    JSON.stringify({
      blockers: [],
      warnings: [],
      nitpicks: [],
      summary: 'ready',
      reviewReadFingerprint: {
        firstLine: '# Plan',
        lastLine: '- step 12',
      },
    }),
  );
  assert.deepStrictEqual(r.reviewReadFingerprint, {
    firstLine: '# Plan',
    lastLine: '- step 12',
  });
});

test('parseReviewResult: rejects reviewReadFingerprint that is not an object', () => {
  assert.throws(
    () =>
      parseReviewResult(
        JSON.stringify({
          blockers: [],
          warnings: [],
          nitpicks: [],
          summary: 'x',
          reviewReadFingerprint: 'bad',
        }),
      ),
    ParseError,
  );
});

test('parseReviewResult: rejects reviewReadFingerprint with non-string firstLine', () => {
  assert.throws(
    () =>
      parseReviewResult(
        JSON.stringify({
          blockers: [],
          warnings: [],
          nitpicks: [],
          summary: 'x',
          reviewReadFingerprint: { firstLine: 42, lastLine: 'b' },
        }),
      ),
    ParseError,
  );
});

test('parseReviewResult: rejects reviewReadFingerprint with non-string lastLine', () => {
  assert.throws(
    () =>
      parseReviewResult(
        JSON.stringify({
          blockers: [],
          warnings: [],
          nitpicks: [],
          summary: 'x',
          reviewReadFingerprint: { firstLine: 'a', lastLine: 99 },
        }),
      ),
    ParseError,
  );
});

test('parseReviewResult: rejects malformed json', () => {
  assert.throws(() => parseReviewResult('{oops'), ParseError);
});

test('parsePlanningContext: parses valid context', () => {
  const c = parsePlanningContext(
    JSON.stringify({
      objective: 'build auth',
      constraints: ['TypeScript'],
      nonGoals: ['billing'],
      assumptions: ['pi SDK available'],
      deferredItems: ['role matrix'],
      repoFindings: ['uses Fastify'],
    }),
  );
  assert.deepStrictEqual(c, {
    objective: 'build auth',
    constraints: ['TypeScript'],
    nonGoals: ['billing'],
    assumptions: ['pi SDK available'],
    deferredItems: ['role matrix'],
    repoFindings: ['uses Fastify'],
  });
});

test('parsePlanningContext: rejects missing objective', () => {
  assert.throws(
    () =>
      parsePlanningContext(
        JSON.stringify({
          constraints: ['TypeScript'],
          nonGoals: ['billing'],
          assumptions: ['pi SDK available'],
          deferredItems: ['role matrix'],
          repoFindings: ['uses Fastify'],
        }),
      ),
    ParseError,
  );
});

test('parsePlanningContext: rejects non-array constraints', () => {
  assert.throws(
    () =>
      parsePlanningContext(
        JSON.stringify({
          objective: 'build auth',
          constraints: 'TypeScript',
          nonGoals: [],
          assumptions: [],
          deferredItems: [],
          repoFindings: [],
        }),
      ),
    ParseError,
  );
});

test('parsePlanningContext: rejects empty string in array', () => {
  assert.throws(
    () =>
      parsePlanningContext(
        JSON.stringify({
          objective: 'build auth',
          constraints: [''],
          nonGoals: [],
          assumptions: [],
          deferredItems: [],
          repoFindings: [],
        }),
      ),
    ParseError,
  );
});
