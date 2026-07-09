/**
 * `/plan [problem]` command.
 *
 * Starts an interview-driven planning session in the current session. The
 * planner uses synchronous `pi-subagents` delegation for focused exploration,
 * GitHub/code research, and plan review before expanding a reviewed bundle into
 * phase artifacts plus the living REQUIREMENTS/ROADMAP/STATE docs.
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
      'No-arg scaffolds the empty REQUIREMENTS/ROADMAP/STATE ledger; /plan "<topic>" starts an interview-driven planning conversation that uses synchronous foreground subagents and expands a reviewed bundle into phase artifacts plus living docs after review passes.',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const topic = args.trim();

      // No-arg: mechanically scaffold the living ledger docs. This branch does
      // not need the subagent tool; it just enables scaffold-docs and asks the
      // model to call it.
      if (!topic) {
        pi.setActiveTools(scaffoldToolNames());
        try {
          pi.sendUserMessage(buildScaffoldPrompt());
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Failed to scaffold docs: ${msg}`, 'error');
        }
        return;
      }

      if (!pi.getActiveTools().includes('subagent')) {
        ctx.ui.notify(
          'plan requires the subagent tool from @gotgenes/pi-subagents. Enable that extension and retry.',
          'error',
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

/** Tools active for no-arg `/plan`: read-only grounding + the scaffold writer. */
export function scaffoldToolNames(): string[] {
  return ['read', 'ls', 'scaffold-docs'];
}

/**
 * Starter message for no-arg `/plan`: instruct the model to bootstrap the
 * living ledger by calling `scaffold-docs`. Kept inline (not a prompt file)
 * because the instruction is a single mechanical tool call.
 */
export function buildScaffoldPrompt(): string {
  return [
    'Bootstrap the living planning ledger for this project.',
    '',
    'Call the `scaffold-docs` tool once. It writes empty docs/REQUIREMENTS.md, docs/ROADMAP.md, and docs/STATE.md from templates and refuses to clobber any of those docs that already has real content.',
    '',
    'Do not interview, do not plan, and do not write any file yourself — `scaffold-docs` is the only action for no-arg `/plan`. After it returns, report which docs were written vs. left untouched, and tell the user to run `/plan "<topic>"` to plan the first phase.',
  ].join('\n');
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
