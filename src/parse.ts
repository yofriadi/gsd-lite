/**
 * Strict parsing of plan-reviewer output.
 */

import type {
  GsdReviewResult,
  PlanningContext,
  ReviewEntry,
  ReviewReadFingerprint,
} from './types.js';

export class ParseError extends Error {
  constructor(
    message: string,
    readonly entryType: string,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

/** Extract the first ```json fenced block from assistant text, else the whole text. */
export function extractJsonBlock(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? text).trim();
}

/** Parse assistant text into an object, locating a fenced json block first. */
export function parseJsonObject(
  text: string,
  entryType: string,
): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonBlock(text));
  } catch (e) {
    throw new ParseError(
      `Could not parse JSON for ${entryType}: ${(e as Error).message}`,
      entryType,
    );
  }
  if (!isRecord(raw)) {
    throw new ParseError(`Expected a JSON object for ${entryType}.`, entryType);
  }
  return raw;
}

export function parseReviewResult(text: string): GsdReviewResult {
  const obj = parseJsonObject(text, 'gsd-review-result');
  return {
    blockers: requireReviewEntryArray(obj, 'blockers', 'gsd-review-result'),
    warnings: requireReviewEntryArray(obj, 'warnings', 'gsd-review-result'),
    nitpicks: requireReviewEntryArray(obj, 'nitpicks', 'gsd-review-result'),
    summary: requireString(obj, 'summary', 'gsd-review-result'),
    ...requireReadFingerprint(obj, 'gsd-review-result'),
  };
}

function requireReadFingerprint(
  obj: Record<string, unknown>,
  entryType: string,
): { reviewReadFingerprint?: ReviewReadFingerprint } {
  const v = obj.reviewReadFingerprint;
  if (v === undefined) return {};
  if (!isRecord(v)) {
    throw new ParseError(
      `${entryType}.reviewReadFingerprint must be an object when present`,
      entryType,
    );
  }
  if (typeof v.firstLine !== 'string') {
    throw new ParseError(
      `${entryType}.reviewReadFingerprint.firstLine must be a string`,
      entryType,
    );
  }
  if (typeof v.lastLine !== 'string') {
    throw new ParseError(
      `${entryType}.reviewReadFingerprint.lastLine must be a string`,
      entryType,
    );
  }
  return {
    reviewReadFingerprint: {
      firstLine: v.firstLine,
      lastLine: v.lastLine,
    },
  };
}

export function parsePlanningContext(text: string): PlanningContext {
  const obj = parseJsonObject(text, 'gsd-planning-context');
  return {
    objective: requireString(obj, 'objective', 'gsd-planning-context'),
    constraints: requireStringArray(obj, 'constraints', 'gsd-planning-context'),
    nonGoals: requireStringArray(obj, 'nonGoals', 'gsd-planning-context'),
    assumptions: requireStringArray(obj, 'assumptions', 'gsd-planning-context'),
    deferredItems: requireStringArray(
      obj,
      'deferredItems',
      'gsd-planning-context',
    ),
    repoFindings: requireStringArray(
      obj,
      'repoFindings',
      'gsd-planning-context',
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  entryType: string,
): string {
  const v = obj[key];
  if (typeof v !== 'string') {
    throw new ParseError(`${entryType}.${key} must be a string`, entryType);
  }
  return v;
}

function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
  entryType: string,
): string[] {
  const arr = requireArray(obj, key, entryType);
  return arr.map((v, i) => {
    if (typeof v !== 'string' || v.length === 0) {
      throw new ParseError(
        `${entryType}.${key}[${i}] must be a non-empty string`,
        entryType,
      );
    }
    return v;
  });
}

function requireArray(
  obj: Record<string, unknown>,
  key: string,
  entryType: string,
): unknown[] {
  const v = obj[key];
  if (!Array.isArray(v)) {
    throw new ParseError(`${entryType}.${key} must be an array`, entryType);
  }
  return v;
}

/**
 * Parse a reviewer array whose items are either:
 *   - `ReviewEntry` objects: `{issue, fix?}`
 *   - plain strings (legacy format): treated as `{issue}`
 */
function requireReviewEntryArray(
  obj: Record<string, unknown>,
  key: string,
  entryType: string,
): ReviewEntry[] {
  const arr = requireArray(obj, key, entryType);
  return arr.map((v, i) => parseReviewEntry(v, key, i, entryType));
}

function parseReviewEntry(
  v: unknown,
  arrayKey: string,
  index: number,
  entryType: string,
): ReviewEntry {
  if (typeof v === 'string') {
    if (v.length === 0) {
      throw new ParseError(
        `${entryType}.${arrayKey}[${index}] string must be non-empty`,
        entryType,
      );
    }
    return { issue: v };
  }
  if (!isRecord(v)) {
    throw new ParseError(
      `${entryType}.${arrayKey}[${index}] must be a string or {issue,fix} object`,
      entryType,
    );
  }
  const issue = v.issue;
  if (typeof issue !== 'string' || issue.length === 0) {
    throw new ParseError(
      `${entryType}.${arrayKey}[${index}].issue must be a non-empty string`,
      entryType,
    );
  }
  if (v.fix !== undefined && typeof v.fix !== 'string') {
    throw new ParseError(
      `${entryType}.${arrayKey}[${index}].fix must be a string when present`,
      entryType,
    );
  }
  const entry: ReviewEntry = { issue };
  if (v.fix !== undefined) entry.fix = v.fix;
  return entry;
}
