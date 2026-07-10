import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { ParseError, parseReviewResult } from './parse.js';
import { fingerprintEquals, planFingerprint } from './plan-tools.js';
import {
  ENTRY,
  type GsdChangeReviewCycle,
  type GsdReviewResult,
  type GsdStoredCandidateChange,
  type ReviewEntry,
  type VerifyResult,
} from './types.js';

type BuildToolAPI = Pick<ExtensionAPI, 'appendEntry'>;

type BranchSessionManager = {
  getBranch(): Array<{ type?: string; customType?: string; data?: unknown }>;
};

type ValidateChangeParams = {
  reviewStatus?: 'completed' | 'aborted' | 'stopped' | 'error';
};

type OutOfScopeMatch = {
  file: string;
  pattern: string;
};

const execFileAsync = promisify(execFile);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === 'string');

function asBranchSessionManager(value: unknown): BranchSessionManager | null {
  if (!isRecord(value) || typeof value.getBranch !== 'function') return null;
  return value as unknown as BranchSessionManager;
}

function isReviewEntry(value: unknown): value is ReviewEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.issue === 'string' &&
    value.issue.length > 0 &&
    (value.fix === undefined || typeof value.fix === 'string')
  );
}

function isReviewEntryArray(value: unknown): value is ReviewEntry[] {
  return Array.isArray(value) && value.every(isReviewEntry);
}

function isFingerprint(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.firstLine === 'string' && typeof value.lastLine === 'string'
  );
}

function isReviewResultData(value: unknown): value is GsdReviewResult {
  if (
    !isRecord(value) ||
    !isReviewEntryArray(value.blockers) ||
    !isReviewEntryArray(value.warnings) ||
    !isReviewEntryArray(value.nitpicks) ||
    typeof value.summary !== 'string'
  ) {
    return false;
  }
  if (value.reviewReadFingerprint === undefined) return true;
  return isFingerprint(value.reviewReadFingerprint);
}

function isVerifyResultData(value: unknown): value is VerifyResult {
  if (!isRecord(value)) return false;
  return (
    (value.command === null || typeof value.command === 'string') &&
    (value.exitCode === null || typeof value.exitCode === 'number') &&
    typeof value.ok === 'boolean'
  );
}

function isChangeReviewCycleData(
  value: unknown,
): value is GsdChangeReviewCycle {
  if (
    !isRecord(value) ||
    typeof value.iteration !== 'number' ||
    typeof value.planId !== 'string' ||
    typeof value.sliceN !== 'number' ||
    typeof value.candidateChange !== 'string' ||
    typeof value.raw !== 'string' ||
    !isVerifyResultData(value.verify)
  ) {
    return false;
  }
  if (value.ok === true) {
    return (
      (value.status === 'needs-revision' || value.status === 'clean') &&
      isReviewResultData(value.review)
    );
  }
  return (
    value.ok === false &&
    (value.status === 'error' ||
      value.status === 'aborted' ||
      value.status === 'stopped' ||
      value.status === 'parse') &&
    typeof value.message === 'string'
  );
}

function isStoredCandidateChangeData(
  value: unknown,
): value is GsdStoredCandidateChange {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  if (typeof value.iteration !== 'number') return false;
  if (typeof value.planId !== 'string' || value.planId.length === 0) {
    return false;
  }
  if (typeof value.sliceN !== 'number') return false;
  if (typeof value.path !== 'string' || value.path.length === 0) return false;
  if (typeof value.change !== 'string') return false;
  return value.touchedFiles === undefined || isStringArray(value.touchedFiles);
}

function findStoredCandidateChange(
  sessionManager: unknown,
  id: string,
): GsdStoredCandidateChange | undefined {
  const session = asBranchSessionManager(sessionManager);
  if (!session) return undefined;
  const branch = session.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (
      entry?.type === 'custom' &&
      entry.customType === ENTRY.storedCandidateChange &&
      isStoredCandidateChangeData(entry.data) &&
      entry.data.id === id
    ) {
      return entry.data;
    }
  }
  return undefined;
}

function latestChangeReviewCycle(
  sessionManager: unknown,
  planId: string,
  sliceN: number,
): GsdChangeReviewCycle | undefined {
  const session = asBranchSessionManager(sessionManager);
  if (!session) return undefined;
  const branch = session.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (
      entry?.type === 'custom' &&
      entry.customType === ENTRY.changeReviewCycle &&
      isChangeReviewCycleData(entry.data) &&
      entry.data.planId === planId &&
      entry.data.sliceN === sliceN
    ) {
      return entry.data;
    }
  }
  return undefined;
}

function nextChangeReviewIteration(
  sessionManager: unknown,
  planId: string,
  sliceN: number,
): number {
  const latest = latestChangeReviewCycle(sessionManager, planId, sliceN);
  return latest ? latest.iteration + 1 : 1;
}

/** Random 16-char hex id used to reference a stored candidate change. */
function newCandidateChangeId(): string {
  return randomBytes(8).toString('hex');
}

function normalizeRepoPath(path: string): string {
  let normalized = path.trim().replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+/g, '/');
  return normalized;
}

function hasGlob(pattern: string): boolean {
  return pattern.includes('*');
}

function splitRepoPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function collapseGlobstars(segments: string[]): string[] {
  const collapsed: string[] = [];
  for (const segment of segments) {
    if (segment === '**' && collapsed[collapsed.length - 1] === '**') continue;
    collapsed.push(segment);
  }
  return collapsed;
}

function segmentMatchesGlob(pattern: string, segment: string): boolean {
  let patternIndex = 0;
  let segmentIndex = 0;
  let starIndex = -1;
  let starMatchIndex = 0;

  while (segmentIndex < segment.length) {
    if (pattern[patternIndex] === '*') {
      starIndex = patternIndex;
      starMatchIndex = segmentIndex;
      patternIndex++;
      continue;
    }

    if (pattern[patternIndex] === segment[segmentIndex]) {
      patternIndex++;
      segmentIndex++;
      continue;
    }

    if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      starMatchIndex++;
      segmentIndex = starMatchIndex;
      continue;
    }

    return false;
  }

  while (pattern[patternIndex] === '*') patternIndex++;
  return patternIndex === pattern.length;
}

function globMatchesPath(pattern: string, file: string): boolean {
  const patternSegments = collapseGlobstars(splitRepoPath(pattern));
  const fileSegments = splitRepoPath(file);
  let patternIndex = 0;
  let fileIndex = 0;
  let globstarIndex = -1;
  let globstarMatchIndex = 0;

  while (fileIndex < fileSegments.length) {
    const patternSegment = patternSegments[patternIndex];
    if (patternSegment === '**') {
      globstarIndex = patternIndex;
      globstarMatchIndex = fileIndex;
      patternIndex++;
      continue;
    }

    if (
      patternSegment !== undefined &&
      segmentMatchesGlob(patternSegment, fileSegments[fileIndex] ?? '')
    ) {
      patternIndex++;
      fileIndex++;
      continue;
    }

    if (globstarIndex !== -1) {
      patternIndex = globstarIndex + 1;
      globstarMatchIndex++;
      fileIndex = globstarMatchIndex;
      continue;
    }

    return false;
  }

  while (patternSegments[patternIndex] === '**') patternIndex++;
  return patternIndex === patternSegments.length;
}

function findOutOfScopeMatch(
  file: string,
  patterns: readonly string[],
): OutOfScopeMatch | undefined {
  const normalizedFile = normalizeRepoPath(file);
  for (const rawPattern of patterns) {
    const pattern = normalizeRepoPath(rawPattern);
    if (pattern.length === 0) continue;
    if (hasGlob(pattern)) {
      if (globMatchesPath(pattern, normalizedFile)) {
        return { file: normalizedFile, pattern };
      }
      continue;
    }
    const dirPattern = pattern.endsWith('/') ? pattern : `${pattern}/`;
    if (normalizedFile === pattern || normalizedFile.startsWith(dirPattern)) {
      return { file: normalizedFile, pattern };
    }
  }
  return undefined;
}

export function pathMatchesOutOfScope(
  file: string,
  patterns: readonly string[],
): boolean {
  return findOutOfScopeMatch(file, patterns) !== undefined;
}

function computeVerifyResult(
  verifyCommand: string | null,
  verifyExitCode: number | null,
): VerifyResult {
  return {
    command: verifyCommand,
    exitCode: verifyExitCode,
    ok: verifyCommand === null ? true : verifyExitCode === 0,
  };
}

function verifySummary(verify: VerifyResult): string {
  if (verify.ok) return 'ok';
  return `FAIL(exit ${verify.exitCode === null ? 'unknown' : verify.exitCode})`;
}

function summarizeChangeReview(
  review: GsdReviewResult,
  verify: VerifyResult,
): string {
  return [
    `blockers=${review.blockers.length}`,
    `warnings=${review.warnings.length}`,
    `nitpicks=${review.nitpicks.length}`,
    `verify=${verifySummary(verify)}`,
    review.summary,
  ].join(' | ');
}

function buildChangeCycleFromReview(
  iteration: number,
  planId: string,
  sliceN: number,
  candidateChange: string,
  raw: string,
  review: GsdReviewResult,
  verify: VerifyResult,
): GsdChangeReviewCycle {
  return {
    iteration,
    planId,
    sliceN,
    ok: true,
    candidateChange,
    raw,
    review,
    verify,
    status:
      review.blockers.length === 0 && review.warnings.length === 0 && verify.ok
        ? 'clean'
        : 'needs-revision',
  };
}

function buildChangeCycleFailure(
  iteration: number,
  planId: string,
  sliceN: number,
  candidateChange: string,
  status: 'error' | 'aborted' | 'stopped' | 'parse',
  raw: string,
  verify: VerifyResult,
  message: string,
): GsdChangeReviewCycle {
  return {
    iteration,
    planId,
    sliceN,
    ok: false,
    candidateChange,
    raw,
    verify,
    status,
    message,
  };
}

async function gitAvailable(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

function parseNameOnly(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(normalizeRepoPath)
    .filter((line) => line.length > 0);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function collectGitChangeArtifacts(cwd: string): Promise<
  | {
      ok: true;
      diff: string;
      touchedFiles: string[];
    }
  | { ok: false }
> {
  if (!(await gitAvailable(cwd))) return { ok: false };
  try {
    const [
      unstagedDiff,
      stagedDiff,
      unstagedNames,
      stagedNames,
      untrackedNames,
    ] = await Promise.all([
      gitOutput(cwd, ['diff', '--no-ext-diff']),
      gitOutput(cwd, ['diff', '--cached', '--no-ext-diff']),
      gitOutput(cwd, ['diff', '--name-only', '--no-ext-diff']),
      gitOutput(cwd, ['diff', '--cached', '--name-only', '--no-ext-diff']),
      gitOutput(cwd, ['ls-files', '--others', '--exclude-standard']),
    ]);
    return {
      ok: true,
      diff: `${unstagedDiff}${stagedDiff}`,
      touchedFiles: uniqueStrings([
        ...parseNameOnly(unstagedNames),
        ...parseNameOnly(stagedNames),
        ...parseNameOnly(untrackedNames),
      ]),
    };
  } catch {
    return { ok: false };
  }
}

function touchedFilesParam(value: unknown): string[] {
  return isStringArray(value) ? value.map(normalizeRepoPath) : [];
}

export function toolStoreCandidateChange(pi: BuildToolAPI): ToolDefinition {
  return defineTool({
    name: 'store-candidate-change',
    label: 'Store Candidate Change',
    description:
      'Write a candidate change-summary doc to disk, persist a session entry that resolves its id to the stored bytes, and return the id and path. Always call this once per change-review cycle before invoking code-reviewer and validate-change.',
    promptSnippet:
      'Call this before code-reviewer and validate-change to store the candidate change-summary doc; pass the returned candidateChangeId to validate-change and the returned path to code-reviewer so it can read the file directly.',
    promptGuidelines: [
      'Call once per review cycle, before invoking code-reviewer and validate-change.',
      'Pass the exact same change-summary doc string you intend to ship to the reviewer; the stored bytes are what the reviewer scores and what validate-change persists.',
      'When revising the change, call store-candidate-change again to get a fresh id; do not reuse an old id with different markdown.',
      'When the review returns blockers or warnings, you must re-store the change-summary doc even if the markdown did not change, so each cycle has its own stored artifact.',
    ],
    parameters: Type.Object({
      change: Type.String(),
      planId: Type.String(),
      sliceN: Type.Number(),
      touchedFiles: Type.Optional(Type.Array(Type.String())),
    }),
    renderCall(args) {
      return new Text(`store: ${String(args.change).slice(0, 60)}`, 0, 0);
    },
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const change = String(params.change);
      const planId = String(params.planId);
      const sliceN = Number(params.sliceN);
      const id = newCandidateChangeId();
      const iteration = nextChangeReviewIteration(
        ctx.sessionManager,
        planId,
        sliceN,
      );
      const relPath = `.gpd/candidate-changes/${id}.md`;
      const absPath = join(ctx.cwd, '.gpd', 'candidate-changes', `${id}.md`);
      const gitArtifacts = await collectGitChangeArtifacts(ctx.cwd);
      const touchedFiles = gitArtifacts.ok
        ? gitArtifacts.touchedFiles
        : touchedFilesParam(params.touchedFiles);

      await mkdir(join(ctx.cwd, '.gpd', 'candidate-changes'), {
        recursive: true,
      });
      await writeFile(absPath, change, 'utf8');
      if (gitArtifacts.ok) {
        await writeFile(
          join(ctx.cwd, '.gpd', 'candidate-changes', `${id}.diff`),
          gitArtifacts.diff,
          'utf8',
        );
      }

      const stored: GsdStoredCandidateChange = {
        id,
        iteration,
        planId,
        sliceN,
        path: relPath,
        change,
        touchedFiles,
      };
      pi.appendEntry(ENTRY.storedCandidateChange, stored);

      return simpleResult(
        `Stored candidate change for ${planId} slice ${sliceN} iteration ${iteration} at ${relPath}. Pass this path to code-reviewer so it can read the file directly, and pass candidateChangeId "${id}" to validate-change.`,
        { ok: true, id, path: relPath, iteration },
      );
    },
  });
}

export function toolValidateChange(pi: BuildToolAPI): ToolDefinition {
  return defineTool({
    name: 'validate-change',
    label: 'Validate Change',
    description:
      'Resolve a stored candidate change-summary doc by id, parse code-reviewer subagent output, persist the latest hard-gated review cycle, and summarize whether another revision is required. This tool does not review the change itself.',
    promptSnippet:
      'After the code-reviewer subagent reviews the candidate change-summary doc, pass its full output into validate-change with the candidateChangeId returned by store-candidate-change.',
    promptGuidelines: [
      'Always store the candidate change-summary doc first via store-candidate-change, then call the code-reviewer subagent with the returned path, then call validate-change with the same candidateChangeId.',
      'This tool only parses and persists that review result; it does not perform the review itself.',
      'If the review subagent failed or was aborted, set reviewStatus so the failed cycle is persisted instead of silently dropping it.',
      'The stored change-summary doc is the single source of truth: the reviewer reads it from disk, and validate-change persists the exact same bytes. Never re-pass the change as inline text.',
      'Pass the verify command and exit code from the fresh verify run; use null for both only when the plan explicitly pins verify: none.',
      'Only treat the slice as complete when the latest persisted review cycle is clean or warnings-only and verify is ok.',
    ],
    parameters: Type.Object({
      candidateChangeId: Type.String(),
      planId: Type.String(),
      sliceN: Type.Number(),
      reviewOutput: Type.String(),
      reviewStatus: Type.Optional(
        Type.Union([
          Type.Literal('completed'),
          Type.Literal('aborted'),
          Type.Literal('stopped'),
          Type.Literal('error'),
        ]),
      ),
      verifyCommand: Type.Union([Type.String(), Type.Null()]),
      verifyExitCode: Type.Union([Type.Number(), Type.Null()]),
      outOfScope: Type.Array(Type.String()),
      touchedFiles: Type.Optional(Type.Array(Type.String())),
    }),
    renderCall(args) {
      return new Text(String(args.candidateChangeId), 0, 0);
    },
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const candidateChangeId = String(params.candidateChangeId);
      const planId = String(params.planId);
      const sliceN = Number(params.sliceN);
      const iteration = nextChangeReviewIteration(
        ctx.sessionManager,
        planId,
        sliceN,
      );
      const raw = (params.reviewOutput as string).trim();
      const reviewStatus =
        (params.reviewStatus as ValidateChangeParams['reviewStatus']) ??
        'completed';
      const verify = computeVerifyResult(
        params.verifyCommand as string | null,
        params.verifyExitCode as number | null,
      );
      const stored = findStoredCandidateChange(
        ctx.sessionManager,
        candidateChangeId,
      );
      if (!stored) {
        return simpleResult(
          `Cannot validate change: no stored candidate change found for id ${candidateChangeId}. Call store-candidate-change first, then re-call validate-change with the returned id.`,
          { ok: false, reason: 'unknown-candidate-change-id' },
        );
      }
      if (stored.planId !== planId || stored.sliceN !== sliceN) {
        return simpleResult(
          `Cannot validate change: stored candidate change ${candidateChangeId} belongs to ${stored.planId} slice ${stored.sliceN}, not ${planId} slice ${sliceN}. Re-store the change for the requested plan and slice before validating.`,
          {
            ok: false,
            reason: 'candidate-scope-mismatch',
            storedPlanId: stored.planId,
            storedSliceN: stored.sliceN,
            currentPlanId: planId,
            currentSliceN: sliceN,
          },
        );
      }
      if (stored.iteration !== iteration) {
        return simpleResult(
          `Cannot validate change: stored candidate change ${candidateChangeId} was prepared for iteration ${stored.iteration} but validate-change is on iteration ${iteration}. Re-store the change (store-candidate-change) and re-run the reviewer.`,
          {
            ok: false,
            reason: 'iteration-mismatch',
            storedIteration: stored.iteration,
            currentIteration: iteration,
          },
        );
      }
      const candidateChange = stored.change;

      if (reviewStatus !== 'completed') {
        const message =
          raw || `code-reviewer finished with status ${reviewStatus}.`;
        const cycle = buildChangeCycleFailure(
          iteration,
          planId,
          sliceN,
          candidateChange,
          reviewStatus,
          raw,
          verify,
          message,
        );
        pi.appendEntry(ENTRY.changeReviewCycle, cycle);
        return simpleResult(
          `${message} Recovery: rerun code-reviewer once and call validate-change again; if the second attempt also fails, stop and surface the failed cycle to the user.`,
          cycle,
        );
      }

      try {
        const review = parseReviewResult(raw);
        if (review.reviewReadFingerprint !== undefined) {
          const expected = planFingerprint(candidateChange);
          if (!fingerprintEquals(review.reviewReadFingerprint, expected)) {
            const message =
              'code-reviewer echoed a reviewReadFingerprint that does not match the stored candidate change-summary doc; refusing to persist a cycle whose reviewed text is not provably the stored text. Re-read the stored change file at the path returned by store-candidate-change and re-call validate-change.';
            const cycle = buildChangeCycleFailure(
              iteration,
              planId,
              sliceN,
              candidateChange,
              'parse',
              raw,
              verify,
              message,
            );
            pi.appendEntry(ENTRY.changeReviewCycle, cycle);
            return simpleResult(message, cycle);
          }
        }

        const touchedFiles =
          stored.touchedFiles ?? touchedFilesParam(params.touchedFiles);
        for (const file of touchedFiles) {
          const match = findOutOfScopeMatch(
            file,
            params.outOfScope as string[],
          );
          if (match) {
            review.blockers.push({
              issue: `out-of-scope path touched: ${match.file} (matches "${match.pattern}")`,
              fix: 'Revert or move the out-of-scope change, or update the plan scope before validating.',
            });
          }
        }

        const cycle = buildChangeCycleFromReview(
          iteration,
          planId,
          sliceN,
          candidateChange,
          raw,
          review,
          verify,
        );
        pi.appendEntry(ENTRY.changeReviewCycle, cycle);
        return simpleResult(summarizeChangeReview(review, verify), cycle);
      } catch (error) {
        const message =
          error instanceof ParseError
            ? error.message
            : 'Failed to parse code-reviewer output.';
        const cycle = buildChangeCycleFailure(
          iteration,
          planId,
          sliceN,
          candidateChange,
          'parse',
          raw,
          verify,
          `${message} Recovery: rerun code-reviewer once and call validate-change again; if the second attempt also fails, stop and surface the failed cycle to the user.`,
        );
        pi.appendEntry(ENTRY.changeReviewCycle, cycle);
        return simpleResult(
          `${message} Recovery: rerun code-reviewer once and call validate-change again; if the second attempt also fails, stop and surface the failed cycle to the user.`,
          cycle,
        );
      }
    },
  });
}

function simpleResult(text: string, details: unknown) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
  };
}
