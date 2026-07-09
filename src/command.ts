/**
 * `/plan [problem]` command.
 *
 * Starts an interview-driven planning session in the current session. The
 * planner uses synchronous `pi-subagents` delegation for focused exploration,
 * GitHub/code research, and plan review before writing the final `PLANS.md`.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, '..');

type PlanAPI = Pick<
  ExtensionAPI,
  'getActiveTools' | 'sendUserMessage' | 'setActiveTools'
>;

export function cmdPlan(pi: PlanAPI) {
  return {
    description:
      'Start an interview-driven planning conversation that uses synchronous foreground subagents and writes PLANS.md after review passes.',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!pi.getActiveTools().includes('subagent')) {
        ctx.ui.notify(
          'plan requires the subagent tool from @gotgenes/pi-subagents. Enable that extension and retry.',
          'error',
        );
        return;
      }

      const topic = args.trim();
      if (!topic) {
        ctx.ui.notify(
          'Please specify a planning topic. E.g., /plan implement auth',
          'warning',
        );
        return;
      }

      pi.setActiveTools(planningToolNames());
      try {
        const prompt = await buildStarterPrompt(topic);
        pi.sendUserMessage(prompt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to start planning: ${msg}`, 'error');
      }
    },
  };
}

export function planningToolNames(): string[] {
  return [
    'read',
    'find',
    'grep',
    'ls',
    'ask_user_question',
    'subagent',
    'store-candidate-plan',
    'validate-plan',
    'finalize-plan',
  ];
}

/** Build the starter user message for the interview phase. */
export async function buildStarterPrompt(topic: string): Promise<string> {
  const plannerStarterPath = join(
    PACKAGE_ROOT,
    'prompts',
    'planner-starter.md',
  );
  try {
    const plannerStarter = await readFile(plannerStarterPath, 'utf8');
    return [plannerStarter, '', '## Problem to Solve', topic].join('\n');
  } catch {
    throw new Error(
      `Internal error: planner-starter.md is missing from the package (path: ${plannerStarterPath})`,
    );
  }
}
