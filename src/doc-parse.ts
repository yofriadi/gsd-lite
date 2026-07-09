/**
 * Parse/serialize the machine-parseable data embedded in the framework's
 * living docs and phase artifacts.
 *
 * Format decisions (Phase 1):
 *   - STATE / ROADMAP / REQUIREMENTS each embed a SINGLE ```json fenced block
 *     as their sole source of truth; surrounding prose is freeform and never
 *     parsed. `parseXDoc` extracts the first fenced block from the whole doc;
 *     `serializeXBlock` emits that fenced block. Round-trip holds on the model
 *     because the serialized block is itself a parseable doc.
 *   - NN-MM-PLAN.md is heading-structured (the builder heading-map scans
 *     `### Slice <N>`), with a tiny top-of-file JSON metadata block for
 *     id/phase/reqIds/verify. `parsePlanDoc` reads the metadata block, the
 *     `## Out of Scope` list, and each `### Slice <N>` heading + its
 *     `#### Consumes` / `#### Produces` blocks. Slice prose is intentionally
 *     skipped. `serializePlanDoc` emits a prose-less doc; round-trip holds on
 *     the model.
 */

import { ParseError, extractJsonBlock } from './parse.js';
import type {
  PlanDoc,
  PlanSlice,
  PlanStatus,
  Requirement,
  RequirementsDoc,
  RoadmapDoc,
  RoadmapPhase,
  StateLedger,
  StatePlan,
  VerifyEvidence,
} from './types.js';

/* ------------------------------------------------------------------ *
 * Local strict-validation helpers (mirror src/parse.ts, scoped here).
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  entryType: string,
): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ParseError(
      `${entryType}.${key} must be a non-empty string`,
      entryType,
    );
  }
  return v;
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

function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
  entryType: string,
): string[] {
  return requireArray(obj, key, entryType).map((v, i) => {
    if (typeof v !== 'string' || v.length === 0) {
      throw new ParseError(
        `${entryType}.${key}[${i}] must be a non-empty string`,
        entryType,
      );
    }
    return v;
  });
}

function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
  entryType: string,
): string[] {
  if (obj[key] === undefined) return [];
  return requireStringArray(obj, key, entryType);
}

function parseDocObject(
  text: string,
  entryType: string,
): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonBlock(text));
  } catch (e) {
    throw new ParseError(
      `Could not parse JSON block for ${entryType}: ${(e as Error).message}`,
      entryType,
    );
  }
  if (!isRecord(raw)) {
    throw new ParseError(`Expected a JSON object for ${entryType}.`, entryType);
  }
  return raw;
}

function fencedJson(value: unknown): string {
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

/* ------------------------------------------------------------------ *
 * STATE
 * ------------------------------------------------------------------ */

const PLAN_STATUSES: readonly PlanStatus[] = ['pending', 'planned', 'built'];

function requirePlanStatus(value: unknown, entryType: string): PlanStatus {
  if (
    typeof value !== 'string' ||
    !PLAN_STATUSES.includes(value as PlanStatus)
  ) {
    throw new ParseError(
      `${entryType}.status must be one of ${PLAN_STATUSES.join('|')}`,
      entryType,
    );
  }
  return value as PlanStatus;
}

export function parseStateDoc(text: string): StateLedger {
  const obj = parseDocObject(text, 'state');
  const pointerRaw = obj.pointer;
  if (pointerRaw !== null && typeof pointerRaw !== 'string') {
    throw new ParseError('state.pointer must be a string or null', 'state');
  }
  if (typeof pointerRaw === 'string' && pointerRaw.length === 0) {
    throw new ParseError(
      'state.pointer must be null, not an empty string',
      'state',
    );
  }
  const plans: StatePlan[] = requireArray(obj, 'plans', 'state').map((p, i) => {
    if (!isRecord(p)) {
      throw new ParseError(`state.plans[${i}] must be an object`, 'state');
    }
    return {
      id: requireString(p, 'id', `state.plans[${i}]`),
      phase: requireString(p, 'phase', `state.plans[${i}]`),
      status: requirePlanStatus(p.status, `state.plans[${i}]`),
    };
  });
  return { pointer: pointerRaw ?? null, plans };
}

export function serializeStateBlock(ledger: StateLedger): string {
  return fencedJson({
    pointer: ledger.pointer,
    plans: ledger.plans.map((p) => ({
      id: p.id,
      phase: p.phase,
      status: p.status,
    })),
  });
}

/* ------------------------------------------------------------------ *
 * ROADMAP
 * ------------------------------------------------------------------ */

export function parseRoadmapDoc(text: string): RoadmapDoc {
  const obj = parseDocObject(text, 'roadmap');
  const phases: RoadmapPhase[] = requireArray(obj, 'phases', 'roadmap').map(
    (p, i) => {
      if (!isRecord(p)) {
        throw new ParseError(
          `roadmap.phases[${i}] must be an object`,
          'roadmap',
        );
      }
      return {
        id: requireString(p, 'id', `roadmap.phases[${i}]`),
        name: requireString(p, 'name', `roadmap.phases[${i}]`),
        reqIds: requireStringArray(p, 'reqIds', `roadmap.phases[${i}]`),
        plans: requireStringArray(p, 'plans', `roadmap.phases[${i}]`),
      };
    },
  );
  return { phases };
}

export function serializeRoadmapBlock(roadmap: RoadmapDoc): string {
  return fencedJson({
    phases: roadmap.phases.map((p) => ({
      id: p.id,
      name: p.name,
      reqIds: p.reqIds,
      plans: p.plans,
    })),
  });
}

/* ------------------------------------------------------------------ *
 * REQUIREMENTS
 * ------------------------------------------------------------------ */

function parseVerifyEvidence(
  value: unknown,
  entryType: string,
): VerifyEvidence {
  if (!isRecord(value)) {
    throw new ParseError(`${entryType}.verify must be an object`, entryType);
  }
  const command = value.command;
  if (command !== null && typeof command !== 'string') {
    throw new ParseError(
      `${entryType}.verify.command must be a string or null`,
      entryType,
    );
  }
  if (typeof value.ok !== 'boolean') {
    throw new ParseError(`${entryType}.verify.ok must be a boolean`, entryType);
  }
  return { command: command ?? null, ok: value.ok };
}

export function parseRequirementsDoc(text: string): RequirementsDoc {
  const obj = parseDocObject(text, 'requirements');
  const requirements: Requirement[] = requireArray(
    obj,
    'requirements',
    'requirements',
  ).map((r, i) => {
    const scope = `requirements.requirements[${i}]`;
    if (!isRecord(r)) {
      throw new ParseError(`${scope} must be an object`, 'requirements');
    }
    const req: Requirement = {
      id: requireString(r, 'id', scope),
      text: requireString(r, 'text', scope),
    };
    if (r.satisfiedBy !== undefined) {
      req.satisfiedBy = requireString(r, 'satisfiedBy', scope);
    }
    if (r.summary !== undefined) {
      req.summary = requireString(r, 'summary', scope);
    }
    if (r.validatedBy !== undefined) {
      if (r.validatedBy !== 'code-reviewer') {
        throw new ParseError(
          `${scope}.validatedBy must be 'code-reviewer' when present`,
          'requirements',
        );
      }
      req.validatedBy = 'code-reviewer';
    }
    if (r.verify !== undefined) {
      req.verify = parseVerifyEvidence(r.verify, scope);
    }
    if (r.evidence !== undefined) {
      req.evidence = requireString(r, 'evidence', scope);
    }
    return req;
  });
  return { requirements };
}

export function serializeRequirementsBlock(doc: RequirementsDoc): string {
  return fencedJson({
    requirements: doc.requirements.map((r) => ({
      id: r.id,
      text: r.text,
      ...(r.satisfiedBy !== undefined ? { satisfiedBy: r.satisfiedBy } : {}),
      ...(r.summary !== undefined ? { summary: r.summary } : {}),
      ...(r.validatedBy !== undefined ? { validatedBy: r.validatedBy } : {}),
      ...(r.verify !== undefined
        ? { verify: { command: r.verify.command, ok: r.verify.ok } }
        : {}),
      ...(r.evidence !== undefined ? { evidence: r.evidence } : {}),
    })),
  });
}

/* ------------------------------------------------------------------ *
 * NN-MM-PLAN.md (heading-structured + tiny metadata block)
 * ------------------------------------------------------------------ */

const SLICE_HEADING_RE = /^###\s+Slice\s+(\d+)\s*:\s*(.*?)\s*(\[[^\]]*\])?\s*$/;

/** Parse a `[REQ-01, REQ-02]` heading suffix into an id list ([] when absent). */
function parseReqBracket(bracket: string | undefined): string[] {
  if (!bracket) return [];
  const inner = bracket.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse only markdown bullet items from a doc region. Non-bullet empty markers
 * such as `_none_` intentionally parse as an empty list.
 */
function parseBulletList(lines: string[]): string[] {
  const items: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*-\s+(.*\S)\s*$/);
    if (m) items.push(m[1]);
  }
  return items;
}

/** Return the lines of the section under `heading`, or null when absent. */
function findSection(
  lines: string[],
  headingRe: RegExp,
  stopRe: RegExp,
): string[] | null {
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (stopRe.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body;
}

function renderBulletList(items: string[]): string {
  if (items.length === 0) return '_none_';
  return items.map((i) => `- ${i}`).join('\n');
}

export function parsePlanDoc(text: string): PlanDoc {
  const normalized = text.replace(/\r\n/g, '\n');
  const meta = parseDocObject(normalized, 'plan');
  const id = requireString(meta, 'id', 'plan');
  const phase = requireString(meta, 'phase', 'plan');
  const reqIds = optionalStringArray(meta, 'reqIds', 'plan');
  const verify =
    meta.verify !== undefined
      ? requireString(meta, 'verify', 'plan')
      : undefined;

  const lines = normalized.split('\n');

  // `## Out of Scope` list (stops at the next `## ` or `### ` heading).
  const outOfScopeBody = findSection(
    lines,
    /^##\s+Out of Scope\s*$/,
    /^#{2,3}\s+/,
  );
  if (outOfScopeBody === null) {
    throw new ParseError(
      'PLAN missing required ## Out of Scope section',
      'plan',
    );
  }
  const outOfScope = parseBulletList(outOfScopeBody);

  // Slice sections: split the doc on `### Slice <N>` headings.
  const slices: PlanSlice[] = [];
  const sliceStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (SLICE_HEADING_RE.test(lines[i])) sliceStarts.push(i);
  }
  for (let s = 0; s < sliceStarts.length; s++) {
    const start = sliceStarts[s];
    const end = s + 1 < sliceStarts.length ? sliceStarts[s + 1] : lines.length;
    const headMatch = lines[start].match(SLICE_HEADING_RE);
    if (!headMatch) continue;
    const n = Number(headMatch[1]);
    const title = headMatch[2].trim();
    const reqIds = parseReqBracket(headMatch[3]);
    const body = lines.slice(start + 1, end);
    // `#### Consumes` / `#### Produces` blocks within this slice.
    const consumesBody = findSection(
      body,
      /^####\s+Consumes\s*$/,
      /^#{1,4}\s+/,
    );
    if (consumesBody === null) {
      throw new ParseError(
        `PLAN slice ${n} missing required #### Consumes section`,
        'plan',
      );
    }
    const producesBody = findSection(
      body,
      /^####\s+Produces\s*$/,
      /^#{1,4}\s+/,
    );
    if (producesBody === null) {
      throw new ParseError(
        `PLAN slice ${n} missing required #### Produces section`,
        'plan',
      );
    }
    const consumes = parseBulletList(consumesBody);
    const produces = parseBulletList(producesBody);
    slices.push({ n, title, reqIds, consumes, produces });
  }

  return { id, phase, reqIds, verify, outOfScope, slices };
}

export function serializePlanDoc(plan: PlanDoc): string {
  const parts: string[] = [];
  parts.push(
    fencedJson({
      id: plan.id,
      phase: plan.phase,
      reqIds: plan.reqIds,
      ...(plan.verify !== undefined ? { verify: plan.verify } : {}),
    }),
  );
  parts.push('');
  parts.push(`# Plan ${plan.id}`);
  parts.push('');
  parts.push('## Out of Scope');
  parts.push(renderBulletList(plan.outOfScope));
  for (const slice of plan.slices) {
    const bracket = slice.reqIds.length ? ` [${slice.reqIds.join(', ')}]` : '';
    parts.push('');
    parts.push(`### Slice ${slice.n}: ${slice.title}${bracket}`);
    parts.push('');
    parts.push('#### Consumes');
    parts.push(renderBulletList(slice.consumes));
    parts.push('');
    parts.push('#### Produces');
    parts.push(renderBulletList(slice.produces));
  }
  return parts.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * NN-MM id allocation
 * ------------------------------------------------------------------ */

/** Zero-pad an integer to at least two digits (3+ digits pass through). */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Phase number parsed from a `NN` phase id or `NN-MM` plan id, else NaN. */
function phaseNumberOf(id: string): number {
  const m = id.match(/^(\d+)/);
  return m ? Number(m[1]) : NaN;
}

/** Plan number (MM) parsed from a `NN-MM` id, else NaN. */
function planNumberOf(id: string): number {
  const m = id.match(/^\d+-(\d+)$/);
  return m ? Number(m[1]) : NaN;
}

/**
 * Allocate the next `NN-MM` plan id.
 *
 * `existing-phase`: the next sequential MM within `phase` (max existing MM + 1,
 * or 01 when the phase has no plans yet).
 * `new-phase`: a brand-new phase NN (max existing phase number + 1, or 01) with
 * MM = 01.
 *
 * `existingPlanIds` are all allocated plan ids (from ROADMAP/STATE).
 * `existingPhaseIds` are ROADMAP phase ids, including phases with zero plans,
 * so `new-phase` cannot reuse an empty existing phase. The user never types
 * the id; the planner supplies the ids it can see and the target.
 */
export function allocatePlanId(
  existingPlanIds: string[],
  target: { kind: 'existing-phase'; phase: string } | { kind: 'new-phase' },
  existingPhaseIds: string[] = [],
): string {
  if (target.kind === 'existing-phase') {
    const phaseNum = phaseNumberOf(target.phase);
    if (Number.isNaN(phaseNum)) {
      throw new Error(`allocatePlanId: invalid phase id "${target.phase}"`);
    }
    const mms = existingPlanIds
      .filter((id) => phaseNumberOf(id) === phaseNum)
      .map(planNumberOf)
      .filter((n) => !Number.isNaN(n));
    const nextMm = mms.length ? Math.max(...mms) + 1 : 1;
    return `${pad2(phaseNum)}-${pad2(nextMm)}`;
  }
  const phaseNums = [...existingPlanIds, ...existingPhaseIds]
    .map(phaseNumberOf)
    .filter((n) => !Number.isNaN(n));
  const nextPhase = phaseNums.length ? Math.max(...phaseNums) + 1 : 1;
  return `${pad2(nextPhase)}-01`;
}
