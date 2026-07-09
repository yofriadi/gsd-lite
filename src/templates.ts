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
