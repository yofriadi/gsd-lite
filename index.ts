/**
 * gsd-lite Pi extension entry point.
 *
 * Registers the `/plan` and `/init` commands plus hard-gated review/finalize
 * and mechanical scaffold/init tools for grilling-led planning with
 * synchronous pi-subagents exploration/research.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { cmdBuild } from './src/build-command.js';
import {
  toolFinalizeBuild,
  toolStoreCandidateChange,
  toolValidateChange,
} from './src/build-tools.js';
import { cmdPlan } from './src/command.js';
import { cmdInit } from './src/init-command.js';
import { toolFinalizeInit, toolScaffoldDocs } from './src/init-tools.js';
import {
  toolFinalizePlan,
  toolStoreCandidatePlan,
  toolValidatePlan,
} from './src/plan-tools.js';

export default function register(pi: ExtensionAPI): void {
  pi.registerTool(toolStoreCandidatePlan(pi));
  pi.registerTool(toolValidatePlan(pi));
  pi.registerTool(toolFinalizePlan(pi));
  pi.registerTool(toolFinalizeInit());
  pi.registerTool(toolScaffoldDocs());
  pi.registerTool(toolStoreCandidateChange(pi));
  pi.registerTool(toolValidateChange(pi));
  pi.registerTool(toolFinalizeBuild(pi));
  pi.registerCommand('plan', cmdPlan(pi));
  pi.registerCommand('init', cmdInit(pi));
  // /build emits the terminal prompt that triggers finalize-build.
  pi.registerCommand('build', cmdBuild(pi));
}
