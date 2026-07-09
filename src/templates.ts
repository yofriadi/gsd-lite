import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, '..');

export type TemplateName =
  | 'PROJECT'
  | 'REQUIREMENTS'
  | 'ROADMAP'
  | 'STATE'
  | 'CONTEXT'
  | 'PLAN'
  | 'SUMMARY';

/**
 * Living ledger doc names written into the target project's `docs/` dir.
 * `PROJECT` is written by `finalize-init`; the `REQUIREMENTS`/`ROADMAP`/`STATE`
 * trio is scaffolded by `scaffold-docs` and evolved by the plan/build tools.
 */
export type DocName = 'PROJECT' | 'REQUIREMENTS' | 'ROADMAP' | 'STATE';

/** Subdirectory of the target project cwd that holds the living ledger docs. */
export const DOCS_DIR = 'docs';

/** Absolute path to a living ledger doc under the target project's `docs/` dir. */
export function docTargetPath(cwd: string, name: DocName): string {
  return join(cwd, DOCS_DIR, `${name}.md`);
}

export function templatePath(name: TemplateName): string {
  return join(PACKAGE_ROOT, 'templates', `${name}.md`);
}

export async function readTemplate(name: TemplateName): Promise<string> {
  const path = templatePath(name);
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new Error(
      `Internal error: ${name}.md is missing from the package templates directory (path: ${path})`,
    );
  }
}
