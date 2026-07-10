import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { readFile as nodeReadFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runSliceOnBranch,
  type BranchEntry,
  type BranchPrimitives,
  type RunSliceOnBranchArgs,
  type SliceStepResult,
} from './build-runtime.js';
import {
  type BuildLoopContext,
  type BuildLoopDeps,
  type BuildLoopResult,
  runBuildLoop as defaultRunBuildLoop,
} from './build-orchestrator.js';
import { parsePlanDoc, parseRoadmapDoc, parseStateDoc } from './doc-parse.js';
import type {
  PlanSlice,
  RoadmapDoc,
  RoadmapPhase,
  StateLedger,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, '..');

export const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const STATUS_KEY = 'gpd-build';
const PROGRESS_STATUS_KEY = 'gpd-build-progress';

type ReadFile = (path: string, encoding: 'utf8') => Promise<string>;

export type BuildAPI = Pick<
  ExtensionAPI,
  | 'sendMessage'
  | 'sendUserMessage'
  | 'appendEntry'
  | 'getActiveTools'
  | 'setActiveTools'
>;

export interface BuildCommandOptions {
  readFile?: ReadFile;
  runBuildLoop?: (
    deps: BuildLoopDeps,
    ctx: BuildLoopContext,
  ) => Promise<BuildLoopResult>;
  runSlice?: (
    prims: BranchPrimitives,
    args: RunSliceOnBranchArgs,
  ) => Promise<SliceStepResult>;
}

export type TargetPlanResolution =
  | { ok: true; planId: string }
  | {
      ok: false;
      reason: 'unknown-plan' | 'nothing-to-build';
      planId?: string;
    };

export interface PlanPaths {
  phase: RoadmapPhase;
  phaseId: string;
  phaseDir: string;
  planPath: string;
  contextPath: string;
}

export function buildToolNames(): string[] {
  return [
    'read',
    'find',
    'grep',
    'ls',
    // write/edit protected-doc denies block the LLM's direct tool mutations.
    // A bash redirect can still bypass them; accepted for v1 because a path
    // deny would also break read-grounding. Mitigated by builder-slice prompt
    // discipline plus finalize-build's persisted-cycle re-verification.
    'bash',
    'write',
    'edit',
    'subagent',
    'store-candidate-change',
    'validate-change',
  ];
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function roadmapPlanSet(roadmap: RoadmapDoc): Set<string> {
  return new Set(roadmap.phases.flatMap((phase) => phase.plans));
}

function statePlanSet(state: StateLedger): Set<string> {
  return new Set(state.plans.map((plan) => plan.id));
}

function planExists(
  state: StateLedger,
  roadmap: RoadmapDoc,
  planId: string,
): boolean {
  return statePlanSet(state).has(planId) && roadmapPlanSet(roadmap).has(planId);
}

function validateResolvedPlan(
  state: StateLedger,
  roadmap: RoadmapDoc,
  planId: string | null,
): TargetPlanResolution {
  if (!planId) return { ok: false, reason: 'nothing-to-build' };
  if (!planExists(state, roadmap, planId)) {
    return { ok: false, reason: 'unknown-plan', planId };
  }
  return { ok: true, planId };
}

export function resolveTargetPlanId(
  state: StateLedger,
  roadmap: RoadmapDoc,
  arg: string,
): TargetPlanResolution {
  const explicit = arg.trim();
  if (explicit.length > 0) {
    return validateResolvedPlan(state, roadmap, explicit);
  }

  const nextPlanId =
    state.next?.command.startsWith('/build') === true
      ? state.next.planId
      : null;
  if (nextPlanId) return validateResolvedPlan(state, roadmap, nextPlanId);
  if (state.pointer) return validateResolvedPlan(state, roadmap, state.pointer);

  const firstPlanned = state.plans.find((plan) => plan.status === 'planned');
  return validateResolvedPlan(state, roadmap, firstPlanned?.id ?? null);
}

export function earlierUnbuiltPlans(
  roadmap: RoadmapDoc,
  state: StateLedger,
  planId: string,
): string[] {
  const ordered = roadmap.phases.flatMap((phase) => phase.plans);
  const targetIndex = ordered.indexOf(planId);
  if (targetIndex <= 0) return [];

  return ordered.slice(0, targetIndex).filter((id) => {
    const status = state.plans.find((plan) => plan.id === id)?.status;
    return status !== 'built';
  });
}

export function planFilePath(
  roadmap: RoadmapDoc,
  planId: string,
): PlanPaths | null {
  const phaseId = planId.split('-')[0] ?? '';
  const phase = roadmap.phases.find((p) => p.id === phaseId);
  if (!phase) return null;

  const phaseDir = join('docs', 'phases', `${phase.id}-${slug(phase.name)}`);
  return {
    phase,
    phaseId,
    phaseDir,
    planPath: join(phaseDir, `${planId}-PLAN.md`),
    contextPath: join(phaseDir, `${phaseId}-CONTEXT.md`),
  };
}

export function cmdBuild(pi: BuildAPI, options: BuildCommandOptions = {}) {
  return {
    description:
      'Run /build with an optional plan id when a planned roadmap item should be built.',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // Phase 7 adds a permission-hook refuse-to-start guard. Phase 5 only
      // checks for subagent because the branch turn spawns code-reviewer.
      if (!pi.getActiveTools().includes('subagent')) {
        ctx.ui.notify(
          'build requires the subagent tool from @gotgenes/pi-subagents. Enable that extension and retry.',
          'error',
        );
        return;
      }

      const readFile = options.readFile ?? nodeReadFile;
      const runBuildLoop = options.runBuildLoop ?? defaultRunBuildLoop;

      try {
        const stateText = await readRequiredDoc(
          readFile,
          ctx.cwd,
          join('docs', 'STATE.md'),
        );
        const roadmapText = await readRequiredDoc(
          readFile,
          ctx.cwd,
          join('docs', 'ROADMAP.md'),
        );
        const state = parseStateDoc(stateText);
        const roadmap = parseRoadmapDoc(roadmapText);

        const resolution = resolveTargetPlanId(state, roadmap, args);
        if (!resolution.ok) {
          if (resolution.reason === 'unknown-plan') {
            ctx.ui.notify(
              `Unknown build plan ${resolution.planId}; run /plan first.`,
              'error',
            );
          } else {
            ctx.ui.notify('Nothing to build; run /plan first.', 'warning');
          }
          return;
        }

        const targetPlan = state.plans.find(
          (plan) => plan.id === resolution.planId,
        );
        const earlier = earlierUnbuiltPlans(roadmap, state, resolution.planId);
        if (earlier.length > 0) {
          ctx.ui.notify(
            `Earlier plan(s) not built: ${earlier.join(', ')}. Proceeding with ${resolution.planId}.`,
            'warning',
          );
        }
        if (targetPlan?.status === 'built') {
          ctx.ui.notify(
            `${resolution.planId} is already built; re-running build.`,
            'warning',
          );
        }

        const paths = planFilePath(roadmap, resolution.planId);
        if (!paths) {
          ctx.ui.notify(
            `Could not find roadmap phase for ${resolution.planId}; run /plan first.`,
            'error',
          );
          return;
        }

        const planText = await readFile(join(ctx.cwd, paths.planPath), 'utf8');
        const plan = parsePlanDoc(planText);
        if (plan.id !== resolution.planId || plan.phase !== paths.phaseId) {
          ctx.ui.notify(
            `PLAN.md id/phase does not match the resolved target ${resolution.planId}; refusing to build a mismatched plan file.`,
            'error',
          );
          return;
        }
        if (plan.slices.length === 0) {
          ctx.ui.notify(
            `${resolution.planId} has no slices to build.`,
            'warning',
          );
          return;
        }

        const parentLeafId = ctx.sessionManager.getLeafId();
        if (!parentLeafId) {
          ctx.ui.notify('Cannot start build: no active session leaf.', 'error');
          return;
        }

        const builderSlicePrompt = await loadBuilderSlicePrompt(readFile);
        pi.setActiveTools(buildToolNames());

        const prims: BranchPrimitives = {
          getLeafId: () => ctx.sessionManager.getLeafId(),
          navigateTree: (targetId, navOptions) =>
            ctx.navigateTree(targetId, navOptions),
          sendUserMessage: (content) => pi.sendUserMessage(content),
          waitForIdle: () => ctx.waitForIdle(),
          getBranch: () =>
            ctx.sessionManager.getBranch() as readonly BranchEntry[],
          sendMessage: (message) =>
            pi.sendMessage({
              customType: message.customType,
              content: message.content,
              display: message.display ?? false,
              details: message.details,
            }),
        };

        const result = await runBuildLoop(
          {
            runSlice: options.runSlice ?? runSliceOnBranch,
            prims,
            appendEntry: (customType, data) => pi.appendEntry(customType, data),
            setStatus: (text) => ctx.ui.setStatus(STATUS_KEY, text),
            notify: (message, type) => ctx.ui.notify(message, type),
            renderProgress: (log) =>
              ctx.ui.setStatus(PROGRESS_STATUS_KEY, log.at(-1)),
            buildSlicePrompt: (
              planId,
              slice,
              planPath,
              contextPath,
              outOfScope,
              verify,
            ) =>
              buildSlicePrompt(
                builderSlicePrompt,
                planId,
                slice,
                planPath,
                contextPath,
                outOfScope,
                verify,
              ),
            timeoutMs: BUILD_TIMEOUT_MS,
          },
          {
            cwd: ctx.cwd,
            planId: plan.id,
            phaseId: plan.phase,
            slices: plan.slices,
            reqIds: plan.reqIds,
            parentLeafId,
            planPath: paths.planPath,
            contextPath: paths.contextPath,
            outOfScope: plan.outOfScope,
            verify: plan.verify,
          },
        );

        if (result.status === 'completed') {
          // finalize-build is implemented/registered in Phase 6/7. This
          // terminal prompt is the trigger once that hard-gate tool exists.
          pi.sendUserMessage(buildFinalizePrompt(plan.id, plan.reqIds));
        } else {
          ctx.ui.notify(
            'Build stopped; re-run /build to resume from the first non-clean slice.',
            result.status === 'blocked' ? 'error' : 'warning',
          );
        }
      } catch (err) {
        if (isMissingFileError(err)) {
          ctx.ui.notify('Missing build docs; run /plan first.', 'error');
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to run build: ${msg}`, 'error');
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.setStatus(PROGRESS_STATUS_KEY, undefined);
      }
    },
  };
}

async function readRequiredDoc(
  readFile: ReadFile,
  cwd: string,
  relPath: string,
): Promise<string> {
  try {
    return await readFile(join(cwd, relPath), 'utf8');
  } catch (err) {
    if (isMissingFileError(err)) {
      throw err;
    }
    throw err;
  }
}

function isMissingFileError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

async function loadBuilderSlicePrompt(readFile: ReadFile): Promise<string> {
  const builderSlicePath = join(PACKAGE_ROOT, 'prompts', 'builder-slice.md');
  try {
    return await readFile(builderSlicePath, 'utf8');
  } catch {
    throw new Error(
      `Internal error: builder-slice.md is missing from the package (path: ${builderSlicePath})`,
    );
  }
}

function buildSlicePrompt(
  basePrompt: string,
  planId: string,
  slice: PlanSlice,
  planPath: string,
  contextPath: string,
  outOfScope: string[],
  verify: string | undefined,
): string {
  const runtimeInputs = {
    planId,
    sliceN: slice.n,
    planPath,
    contextPath,
    sliceGoal: slice.title,
    reqIds: slice.reqIds,
    outOfScope,
    verify: verify ?? null,
  };
  return [
    basePrompt,
    '',
    '## Runtime inputs from /build',
    '',
    '```json',
    JSON.stringify(runtimeInputs, null, 2),
    '```',
  ].join('\n');
}

function buildFinalizePrompt(planId: string, reqIds: string[]): string {
  return [
    `All slices for ${planId} advanced cleanly or with warnings only.`,
    '',
    'Call the `finalize-build` tool for this plan. Before calling it, audit each covered REQ id individually against the persisted slice cycles and the SUMMARY you will write; do not assert completion in aggregate.',
    '',
    `Plan id: ${planId}`,
    `Covered REQ ids: ${reqIds.length > 0 ? reqIds.join(', ') : 'none'}`,
  ].join('\n');
}
