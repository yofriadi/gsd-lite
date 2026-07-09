/**
 * `/init [goal]` command.
 *
 * Authors the project identity doc `docs/PROJECT.md` through the sole gated
 * writer `finalize-init`. No-arg scaffolds the empty PROJECT template;
 * `/init "<goal>"` runs a short grounding interview then writes the authored
 * PROJECT.md. There is no review loop, and no other doc is touched.
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

type InitAPI = Pick<
  ExtensionAPI,
  'getActiveTools' | 'sendUserMessage' | 'setActiveTools'
>;

/** Tools active during `/init`: read-only grounding + interview + the writer. */
export function initToolNames(): string[] {
  return ['read', 'find', 'grep', 'ls', 'ask_user_question', 'finalize-init'];
}

export function cmdInit(pi: InitAPI) {
  return {
    description:
      'Author docs/PROJECT.md. No-arg scaffolds the empty template; /init "<goal>" runs a short interview and writes the identity doc via finalize-init.',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const goal = args.trim();
      pi.setActiveTools(initToolNames());
      try {
        const prompt = await buildInitPrompt(goal);
        pi.sendUserMessage(prompt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to start init: ${msg}`, 'error');
      }
    },
  };
}

/**
 * Build the starter user message for `/init`. Appends the goal (or an
 * explicit no-goal marker so the model takes the scaffold-mode branch) after
 * the shared init-starter body.
 */
export async function buildInitPrompt(goal: string): Promise<string> {
  const initStarterPath = join(PACKAGE_ROOT, 'prompts', 'init-starter.md');
  let initStarter: string;
  try {
    initStarter = await readFile(initStarterPath, 'utf8');
  } catch {
    throw new Error(
      `Internal error: init-starter.md is missing from the package (path: ${initStarterPath})`,
    );
  }
  const tail = goal
    ? ['', '## Goal', goal]
    : ['', '## Goal', '_No goal provided — scaffold the empty PROJECT.md._'];
  return [initStarter, ...tail].join('\n');
}
