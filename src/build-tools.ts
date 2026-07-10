import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import {
  parsePlanDoc,
  parseRequirementsDoc,
  parseRoadmapDoc,
  parseStateDoc,
  serializeRequirementsBlock,
  serializeStateBlock,
} from './doc-parse.js';
import { renderAttemptsTable } from './doc-render.js';
import { ParseError, parseReviewResult } from './parse.js';
import { fingerprintEquals, planFingerprint } from './plan-tools.js';
import { readTemplate } from './templates.js';
import {
  SLICE_RESULT_MESSAGE_TYPE,
  type SliceResultHandoff,
} from './build-runtime.js';
import {
  ENTRY,
  type GsdBuildFinalized,
  type GsdChangeReviewCycle,
  type GsdReviewResult,
  type GsdStoredCandidateChange,
  type Requirement,
  type RequirementsDoc,
  type RoadmapDoc,
  type StateLedger,
  type ReviewEntry,
  type VerifyEvidence,
  type VerifyResult,
} from './types.js';

type BuildToolAPI = Pick<ExtensionAPI, 'appendEntry'>;

export interface FinalizeBuildIO {
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  writeFile?: (
    path: string,
    content: string,
    encoding: 'utf8',
  ) => Promise<void>;
  mkdir?: (path: string, opts: { recursive: true }) => Promise<unknown>;
  rename?: (from: string, to: string) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
}

type SessionEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
};

type BranchSessionManager = {
  getBranch(): SessionEntry[];
};

type EntryLogSessionManager = {
  getEntries(): SessionEntry[];
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

function asEntryLogSessionManager(
  value: unknown,
): EntryLogSessionManager | null {
  if (!isRecord(value) || typeof value.getEntries !== 'function') return null;
  return value as unknown as EntryLogSessionManager;
}

function sessionEntries(sessionManager: unknown): SessionEntry[] {
  const logSession = asEntryLogSessionManager(sessionManager);
  if (logSession) return logSession.getEntries();
  const branchSession = asBranchSessionManager(sessionManager);
  return branchSession ? branchSession.getBranch() : [];
}

function isMissingFileError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
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

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** A phase id is exactly `NN` (two or more digits). */
function isValidPhaseId(id: string): boolean {
  return /^\d{2,}$/.test(id);
}

/** A plan id is exactly `NN-MM` (two or more digits, dash, two or more digits). */
function isValidPlanId(id: string): boolean {
  return /^\d{2,}-\d{2,}$/.test(id);
}

function replaceJsonBlock(templateText: string, newBlock: string): string {
  const replaced = templateText.replace(/```json[\s\S]*?```/, newBlock);
  return ensureTrailingNewline(replaced);
}

function replaceMarkdownSection(
  doc: string,
  heading: string,
  body: string,
): string {
  const normalized = doc.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const headingLine = `## ${heading}`;
  const start = lines.findIndex((line) => line.trim() === headingLine);
  if (start === -1) {
    return ensureTrailingNewline(
      [normalized.replace(/\n+$/, ''), '', headingLine, '', body].join('\n'),
    );
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const bodyLines = body.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  lines.splice(start + 1, end - start - 1, '', ...bodyLines, '');
  return ensureTrailingNewline(
    lines.join('\n').replace(/\n{3,}(?=##\s+)/g, '\n\n'),
  );
}

function sectionBody(renderedSection: string): string {
  const lines = renderedSection.replace(/\r\n/g, '\n').split('\n');
  if (/^##\s+/.test(lines[0] ?? '')) return lines.slice(1).join('\n').trim();
  return renderedSection.trim();
}

function bulletsOrNone(items: readonly string[]): string {
  if (items.length === 0) return '- _none_';
  return items.map((item) => `- ${item}`).join('\n');
}

export function advanceStateAfterBuild(
  state: StateLedger,
  roadmap: RoadmapDoc,
  planId: string,
): StateLedger {
  const plans = state.plans.map((plan) =>
    plan.id === planId ? { ...plan, status: 'built' as const } : { ...plan },
  );
  const statusByPlan = new Map(plans.map((plan) => [plan.id, plan.status]));
  const orderedPlanIds = roadmap.phases.flatMap((phase) => phase.plans);
  const nextPlanned = orderedPlanIds.find(
    (id) => statusByPlan.get(id) === 'planned',
  );
  if (nextPlanned) {
    return {
      pointer: nextPlanned,
      next: {
        command: '/build',
        planId: nextPlanned,
        reason: 'planned-but-unbuilt',
      },
      plans,
    };
  }
  const nextPending = orderedPlanIds.find(
    (id) => statusByPlan.get(id) === 'pending',
  );
  if (nextPending) {
    return {
      pointer: nextPending,
      next: {
        command: '/plan',
        planId: nextPending,
        reason: 'roadmap-item-pending',
      },
      plans,
    };
  }
  return { pointer: null, next: null, plans };
}

export function closeRequirements(
  doc: RequirementsDoc,
  reqIds: string[],
  evidence: {
    planId: string;
    summaryPath: string;
    verify: VerifyEvidence;
    commitRange?: string;
  },
): RequirementsDoc {
  const closingReqIds = new Set(reqIds);
  return {
    requirements: doc.requirements.map((req) => {
      if (!closingReqIds.has(req.id)) return { ...req };
      const closed: Requirement = {
        ...req,
        satisfiedBy: evidence.planId,
        summary: evidence.summaryPath,
        validatedBy: 'code-reviewer',
        verify: { command: evidence.verify.command, ok: true },
      };
      if (evidence.commitRange !== undefined) {
        closed.evidence = evidence.commitRange;
      } else {
        delete closed.evidence;
      }
      return closed;
    }),
  };
}

function splitCommitRange(range: string): [string, string] | null {
  const idx = range.indexOf('..');
  if (idx === -1) return null;
  const base = range.slice(0, idx);
  const head = range.slice(idx + 2);
  if (base.length === 0 || head.length === 0) return null;
  return [base, head];
}

export function deriveCommitRange(ranges: string[]): string | undefined {
  const cleaned = ranges.map((range) => range.trim()).filter(Boolean);
  if (cleaned.length === 0) return undefined;
  if (cleaned.length === 1) return cleaned[0];
  const parsed = cleaned.map(splitCommitRange);
  if (parsed.some((range) => range === null)) {
    return [...new Set(cleaned)].join(', ');
  }
  const first = parsed[0];
  const last = parsed[parsed.length - 1];
  if (!first || !last) return [...new Set(cleaned)].join(', ');
  return `${first[0]}..${last[1]}`;
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

function latestBySlice<T extends { sliceN: number; iteration: number }>(
  values: readonly T[],
): Map<number, T> {
  const latest = new Map<number, T>();
  for (const value of values) {
    const prev = latest.get(value.sliceN);
    if (!prev || value.iteration >= prev.iteration)
      latest.set(value.sliceN, value);
  }
  return latest;
}

function changeReviewCyclesForPlan(
  entries: readonly SessionEntry[],
  planId: string,
): GsdChangeReviewCycle[] {
  return entries
    .filter(
      (entry) =>
        entry.customType === ENTRY.changeReviewCycle &&
        isChangeReviewCycleData(entry.data) &&
        entry.data.planId === planId,
    )
    .map((entry) => entry.data as GsdChangeReviewCycle);
}

function storedCandidateChangesForPlan(
  entries: readonly SessionEntry[],
  planId: string,
): GsdStoredCandidateChange[] {
  return entries
    .filter(
      (entry) =>
        entry.customType === ENTRY.storedCandidateChange &&
        isStoredCandidateChangeData(entry.data) &&
        entry.data.planId === planId,
    )
    .map((entry) => entry.data as GsdStoredCandidateChange);
}

function planAndSliceReqIds(plan: {
  reqIds: string[];
  slices: Array<{ reqIds: string[] }>;
}): string[] {
  const referenced = new Set<string>(plan.reqIds);
  for (const slice of plan.slices) {
    for (const reqId of slice.reqIds) referenced.add(reqId);
  }
  return [...referenced];
}

function sliceReqIdsNotClaimed(plan: {
  reqIds: string[];
  slices: Array<{ reqIds: string[] }>;
}): string[] {
  const claimed = new Set(plan.reqIds);
  const missing = new Set<string>();
  for (const slice of plan.slices) {
    for (const reqId of slice.reqIds) {
      if (!claimed.has(reqId)) missing.add(reqId);
    }
  }
  return [...missing];
}

function latestAcceptedCycle(
  cycles: readonly GsdChangeReviewCycle[],
  latestCycles: ReadonlyMap<number, GsdChangeReviewCycle>,
  sliceNs: ReadonlySet<number>,
): GsdChangeReviewCycle | undefined {
  for (let i = cycles.length - 1; i >= 0; i--) {
    const cycle = cycles[i];
    if (
      cycle &&
      sliceNs.has(cycle.sliceN) &&
      latestCycles.get(cycle.sliceN) === cycle &&
      cycle.ok
    ) {
      return cycle;
    }
  }
  return undefined;
}

function isSliceResultHandoff(value: unknown): value is SliceResultHandoff {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === 'string' &&
    typeof value.digest === 'string' &&
    isRecord(value.counts) &&
    isVerifyResultData(value.verify) &&
    (value.outcome === 'clean' ||
      value.outcome === 'warnings-only' ||
      value.outcome === 'blockers') &&
    (value.commitRange === undefined || typeof value.commitRange === 'string')
  );
}

function sliceResultSliceN(
  planId: string,
  handoff: SliceResultHandoff,
): number | null {
  const marker = `${planId}-slice-`;
  const idx = handoff.path.replace(/\\/g, '/').lastIndexOf(marker);
  if (idx === -1) return null;
  const rest = handoff.path.slice(idx + marker.length);
  const match = rest.match(/^(\d+)\.md$/);
  return match ? Number(match[1]) : null;
}

function commitRangesFromSliceResults(
  entries: readonly SessionEntry[],
  planId: string,
): string[] {
  const latestByResultSlice = new Map<
    number,
    { order: number; sliceN: number; commitRange: string }
  >();
  for (let order = 0; order < entries.length; order++) {
    const entry = entries[order];
    if (entry?.customType !== SLICE_RESULT_MESSAGE_TYPE) continue;
    const payload = isSliceResultHandoff(entry.details)
      ? entry.details
      : isSliceResultHandoff(entry.data)
        ? entry.data
        : null;
    if (!payload || payload.commitRange === undefined) continue;
    const sliceN = sliceResultSliceN(planId, payload);
    if (sliceN === null) continue;
    latestByResultSlice.set(sliceN, {
      order,
      sliceN,
      commitRange: payload.commitRange,
    });
  }
  return [...latestByResultSlice.values()]
    .sort((a, b) => a.sliceN - b.sliceN || a.order - b.order)
    .map((item) => item.commitRange);
}

async function atomicWriteAll(
  entries: ReadonlyArray<{ path: string; content: string }>,
  io: Required<
    Pick<FinalizeBuildIO, 'writeFile' | 'mkdir' | 'rename' | 'unlink'>
  >,
): Promise<void> {
  const staged: Array<{ tmp: string; path: string }> = [];
  try {
    for (const { path, content } of entries) {
      const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      staged.push({ tmp, path });
      await io.mkdir(dirname(path), { recursive: true });
      await io.writeFile(tmp, content, 'utf8');
    }
  } catch (err) {
    await Promise.all(staged.map((s) => io.unlink(s.tmp).catch(() => {})));
    throw err;
  }
  for (const { tmp, path } of staged) {
    await io.rename(tmp, path);
  }
}

async function clearFlatDir(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries.map((name) => unlink(join(dir, name)).catch(() => {})),
  );
  await rmdir(dir).catch(() => {});
}

export async function clearBuildArtifacts(cwd: string): Promise<void> {
  await Promise.all([
    clearFlatDir(join(cwd, '.gpd', 'candidate-changes')),
    clearFlatDir(join(cwd, '.gpd', 'slice-results')),
  ]);
}

function roadmapPlanSet(roadmap: RoadmapDoc): Set<string> {
  return new Set(roadmap.phases.flatMap((phase) => phase.plans));
}

function statePlanSet(state: StateLedger): Set<string> {
  return new Set(state.plans.map((plan) => plan.id));
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

export function toolFinalizeBuild(
  pi: BuildToolAPI,
  io: FinalizeBuildIO = {},
): ToolDefinition {
  return defineTool({
    name: 'finalize-build',
    label: 'Finalize Build',
    description:
      'Finalize a completed /build only after re-verifying every persisted slice review cycle, refusing blockers or failing verify results, accepting warnings only when explicitly allowed, closing REQUIREMENTS traceability, advancing STATE, writing SUMMARY, and appending a build-finalized entry.',
    promptSnippet:
      'Call finalize-build from the /build terminal prompt once all slices for the plan are clean or warnings-only. Pass acceptWarnings: true only when the user explicitly accepts remaining warnings.',
    promptGuidelines: [
      'This tool re-reads STATE, ROADMAP, REQUIREMENTS, the PLAN doc, and the full append-only session log; do not summarize slice status yourself.',
      'Every slice in the PLAN must have a latest persisted change-review-cycle. Missing, failed, blocker, or verify-failing cycles always refuse; failing verify can never be accepted.',
      'Warnings-only slices finalize only when acceptWarnings is true and the user explicitly accepts those warnings.',
      'The tool independently re-checks stored touched files against the PLAN out-of-scope list before writing anything.',
      'On success it writes NN-MM-SUMMARY.md, advances STATE.md, closes REQUIREMENTS.md traceability, clears build scratch artifacts, and appends build-finalized.',
    ],
    parameters: Type.Object({
      planId: Type.String(),
      summary: Type.String(),
      deliverables: Type.Array(Type.String()),
      acceptWarnings: Type.Optional(Type.Boolean()),
    }),
    renderCall(args) {
      return new Text(String(args.planId), 0, 0);
    },
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const planId = String(params.planId);
      if (!isValidPlanId(planId)) {
        return simpleResult(
          `Cannot finalize build: plan id ${JSON.stringify(planId)} is not a valid NN-MM id.`,
          { ok: false, reason: 'bad-plan-id', planId },
        );
      }

      const readFileFs = io.readFile ?? readFile;
      const writeIo = {
        writeFile: io.writeFile ?? writeFile,
        mkdir: io.mkdir ?? mkdir,
        rename: io.rename ?? rename,
        unlink: io.unlink ?? unlink,
      };

      const [stateText, roadmapText, requirementsText] = await Promise.all([
        readFileFs(join(ctx.cwd, 'docs', 'STATE.md'), 'utf8'),
        readFileFs(join(ctx.cwd, 'docs', 'ROADMAP.md'), 'utf8'),
        readFileFs(join(ctx.cwd, 'docs', 'REQUIREMENTS.md'), 'utf8'),
      ]);
      const state = parseStateDoc(stateText);
      const roadmap = parseRoadmapDoc(roadmapText);
      const requirements = parseRequirementsDoc(requirementsText);

      if (
        !statePlanSet(state).has(planId) ||
        !roadmapPlanSet(roadmap).has(planId)
      ) {
        return simpleResult(
          `Cannot finalize build ${planId}: plan is not present in STATE.md and ROADMAP.md; run /build first after finalizing the plan.`,
          { ok: false, reason: 'plan-not-found', planId },
        );
      }

      const phaseId = planId.split('-')[0] ?? '';
      if (!isValidPhaseId(phaseId)) {
        return simpleResult(
          `Cannot finalize build: phase id ${JSON.stringify(phaseId)} is not a valid NN phase id.`,
          { ok: false, reason: 'bad-phase-id', phaseId },
        );
      }
      const phase = roadmap.phases.find(
        (candidate) => candidate.id === phaseId,
      );
      if (!phase) {
        return simpleResult(
          `Cannot finalize build ${planId}: roadmap phase ${phaseId} is missing; run /build first after finalizing the plan.`,
          { ok: false, reason: 'plan-not-found', planId },
        );
      }
      if (!isValidPhaseId(phase.id)) {
        return simpleResult(
          `Cannot finalize build: roadmap phase id ${JSON.stringify(phase.id)} is not a valid NN phase id.`,
          { ok: false, reason: 'bad-phase-id', phaseId: phase.id },
        );
      }

      const phaseDir = `docs/phases/${phase.id}-${slug(phase.name)}`;
      const planPath = `${phaseDir}/${planId}-PLAN.md`;
      let planText: string;
      try {
        planText = await readFileFs(join(ctx.cwd, planPath), 'utf8');
      } catch (err) {
        if (isMissingFileError(err)) {
          return simpleResult(
            `Cannot finalize build ${planId}: ${planPath} is missing; run /build first.`,
            { ok: false, reason: 'plan-not-found', planId },
          );
        }
        throw err;
      }
      const plan = parsePlanDoc(planText);
      if (plan.id !== planId || plan.phase !== phase.id) {
        return simpleResult(
          `Cannot finalize build ${planId}: PLAN metadata does not match ROADMAP/STATE; run /build first on the finalized plan.`,
          { ok: false, reason: 'plan-not-found', planId },
        );
      }
      if (plan.slices.length === 0) {
        return simpleResult(
          `Cannot finalize build ${planId}: PLAN has no slices to finalize.`,
          { ok: false, reason: 'no-slices', planId },
        );
      }

      const entries = sessionEntries(ctx.sessionManager);
      const cycles = changeReviewCyclesForPlan(entries, planId);
      const latestCycles = latestBySlice(cycles);
      const acceptWarnings = params.acceptWarnings === true;
      let acceptedWarnings = 0;

      for (const slice of plan.slices) {
        const latest = latestCycles.get(slice.n);
        if (!latest) {
          return simpleResult(
            `Cannot finalize build ${planId}: slice ${slice.n} has no persisted change-review-cycle. Re-run /build for this plan.`,
            { ok: false, reason: 'missing-cycle', planId, sliceN: slice.n },
          );
        }
        if (!latest.ok) {
          return simpleResult(
            `Cannot finalize build ${planId}: slice ${slice.n} latest review cycle failed (${latest.status}). Re-run /build for this slice.`,
            {
              ok: false,
              reason: 'slice-failed',
              planId,
              sliceN: slice.n,
              status: latest.status,
            },
          );
        }
        if (!latest.verify.ok) {
          return simpleResult(
            `Cannot finalize build ${planId}: slice ${slice.n} verification failed. Failing verify can never be accepted; fix the slice and rerun /build.`,
            { ok: false, reason: 'verify-failed', planId, sliceN: slice.n },
          );
        }
        if (latest.review.blockers.length > 0) {
          return simpleResult(
            `Cannot finalize build ${planId}: slice ${slice.n} still has blocker(s). Blockers can never be accepted; fix the slice and rerun /build.`,
            {
              ok: false,
              reason: 'blockers',
              planId,
              sliceN: slice.n,
              review: latest.review,
            },
          );
        }
        const warningCount = latest.review.warnings.length;
        if (warningCount > 0 && !acceptWarnings) {
          return simpleResult(
            `Cannot finalize build ${planId}: slice ${slice.n} has ${warningCount} warning(s). Either address them and rerun /build, or set acceptWarnings: true after explicit user acceptance.`,
            {
              ok: false,
              reason: 'warnings',
              planId,
              sliceN: slice.n,
              review: latest.review,
            },
          );
        }
        acceptedWarnings += warningCount;
      }

      const storedChanges = storedCandidateChangesForPlan(entries, planId);
      const outOfScopeMatches: OutOfScopeMatch[] = [];
      for (const slice of plan.slices) {
        const latest = latestCycles.get(slice.n);
        if (!latest) {
          return simpleResult(
            `Cannot finalize build ${planId}: slice ${slice.n} has no persisted change-review-cycle. Re-run /build for this plan.`,
            { ok: false, reason: 'missing-cycle', planId, sliceN: slice.n },
          );
        }
        const reviewedStoredChanges = storedChanges.filter(
          (change) =>
            change.planId === planId &&
            change.sliceN === latest.sliceN &&
            change.iteration === latest.iteration &&
            change.change === latest.candidateChange,
        );
        if (reviewedStoredChanges.length === 0) {
          return simpleResult(
            `Cannot finalize build ${planId}: slice ${slice.n} latest review cycle has no matching stored candidate change for iteration ${latest.iteration}. Re-run /build for this slice before finalizing.`,
            {
              ok: false,
              reason: 'missing-stored-change',
              planId,
              sliceN: slice.n,
              iteration: latest.iteration,
            },
          );
        }
        const touchedFiles = new Set<string>();
        for (const stored of reviewedStoredChanges) {
          for (const file of stored.touchedFiles ?? []) touchedFiles.add(file);
        }
        for (const file of touchedFiles) {
          const match = findOutOfScopeMatch(file, plan.outOfScope);
          if (match) outOfScopeMatches.push(match);
        }
      }
      if (outOfScopeMatches.length > 0) {
        return simpleResult(
          `Cannot finalize build ${planId}: stored touched files include out-of-scope path(s): ${outOfScopeMatches
            .map((match) => `${match.file} (${match.pattern})`)
            .join(', ')}.`,
          {
            ok: false,
            reason: 'out-of-scope',
            matches: outOfScopeMatches,
          },
        );
      }

      const requirementsById = new Map(
        requirements.requirements.map((req) => [req.id, req]),
      );
      const unresolvedReqIds = planAndSliceReqIds(plan).filter(
        (reqId) => !requirementsById.has(reqId),
      );
      if (unresolvedReqIds.length > 0) {
        return simpleResult(
          `Cannot finalize build ${planId}: unresolved requirement id(s): ${unresolvedReqIds.join(', ')}.`,
          { ok: false, reason: 'unresolved-req', reqIds: unresolvedReqIds },
        );
      }
      const unclaimedReqIds = sliceReqIdsNotClaimed(plan);
      if (unclaimedReqIds.length > 0) {
        return simpleResult(
          `Cannot finalize build ${planId}: slice requirement id(s) are not claimed by the plan metadata: ${unclaimedReqIds.join(', ')}.`,
          {
            ok: false,
            reason: 'slice-req-not-claimed',
            reqIds: unclaimedReqIds,
          },
        );
      }

      const summaryRel = `${phaseDir}/${planId}-SUMMARY.md`;
      const planSliceNs = new Set(plan.slices.map((slice) => slice.n));
      const latestAccepted = latestAcceptedCycle(
        cycles,
        latestCycles,
        planSliceNs,
      );
      const verifyCommand =
        plan.verify === 'none'
          ? null
          : (plan.verify ?? latestAccepted?.verify.command ?? null);
      const commitRange = deriveCommitRange(
        commitRangesFromSliceResults(entries, planId),
      );
      const verifyEvidence: VerifyEvidence = {
        command: verifyCommand,
        ok: true,
      };
      const advancedState = advanceStateAfterBuild(state, roadmap, planId);
      const closedRequirements = closeRequirements(requirements, plan.reqIds, {
        planId,
        summaryPath: summaryRel,
        verify: verifyEvidence,
        ...(commitRange !== undefined ? { commitRange } : {}),
      });

      const requirementsClosed = plan.reqIds.map((reqId) => {
        const req = requirementsById.get(reqId);
        return `- ${reqId}: ${req?.text ?? ''}`;
      });
      let summaryDoc = (await readTemplate('SUMMARY')).replace(
        /^# Summary NN-MM/m,
        `# Summary ${planId}`,
      );
      summaryDoc = replaceMarkdownSection(
        summaryDoc,
        'Summary',
        String(params.summary).trim() || '_none_',
      );
      summaryDoc = replaceMarkdownSection(
        summaryDoc,
        'Deliverables',
        bulletsOrNone(params.deliverables as string[]),
      );
      summaryDoc = replaceMarkdownSection(
        summaryDoc,
        'Requirements closed',
        requirementsClosed.length > 0
          ? requirementsClosed.join('\n')
          : '- _none_',
      );
      summaryDoc = replaceMarkdownSection(
        summaryDoc,
        'Attempts / Blockers',
        sectionBody(renderAttemptsTable(cycles)),
      );

      const stateDoc = replaceJsonBlock(
        await readTemplate('STATE'),
        serializeStateBlock(advancedState),
      );
      const requirementsDoc = replaceJsonBlock(
        await readTemplate('REQUIREMENTS'),
        serializeRequirementsBlock(closedRequirements),
      );

      await atomicWriteAll(
        [
          { path: join(ctx.cwd, summaryRel), content: summaryDoc },
          { path: join(ctx.cwd, 'docs', 'STATE.md'), content: stateDoc },
          {
            path: join(ctx.cwd, 'docs', 'REQUIREMENTS.md'),
            content: requirementsDoc,
          },
        ],
        writeIo,
      );
      await clearBuildArtifacts(ctx.cwd);

      const finalized: GsdBuildFinalized = {
        planId,
        phaseId: phase.id,
        summaryPath: summaryRel,
        reqIds: plan.reqIds,
        ...(acceptedWarnings > 0 ? { acceptedWarnings } : {}),
      };
      pi.appendEntry(ENTRY.buildFinalized, finalized);
      const warningText =
        acceptedWarnings > 0
          ? ` (${acceptedWarnings} warning(s) explicitly accepted)`
          : '';
      return simpleResult(
        `Finalized build ${planId}: wrote ${summaryRel}, advanced STATE, closed ${plan.reqIds.length} requirement(s)${warningText}.`,
        {
          ok: true,
          planId,
          summaryPath: summaryRel,
          reqIds: plan.reqIds,
          acceptedWarnings,
        },
      );
    },
  });
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
