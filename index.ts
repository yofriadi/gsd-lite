/**
 * gsd-lite Pi extension entry point.
 *
 * Registers the `/gsd-plan` command plus hard-gated review/finalize tools for
 * grilling-led planning with synchronous pi-subagents exploration/research.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { cmdGsdPlan } from './src/command.js';
import {
  toolFinalizePlan,
  toolStoreCandidatePlan,
  toolValidatePlan,
} from './src/plan-tools.js';

export default function register(pi: ExtensionAPI): void {
  pi.registerTool(toolStoreCandidatePlan(pi));
  pi.registerTool(toolValidatePlan(pi));
  pi.registerTool(toolFinalizePlan(pi));
  pi.registerCommand('gsd-plan', cmdGsdPlan(pi));
}
