/**
 * Mechanical scaffold/init tools.
 *
 * These are the sanctioned writers for the framework's living identity docs:
 *   - `finalize-init`  -> writes/updates `docs/PROJECT.md` only.
 *   - `scaffold-docs`  -> writes empty `docs/REQUIREMENTS.md` / `ROADMAP.md` /
 *     `STATE.md` from templates.
 *
 * Both are deliberately entry-free (no session state) and both write
 * atomically (temp-file + rename in the target dir) so a mid-write failure can
 * never leave a half-written doc on disk. Neither runs a review loop.
 *
 * Clobber policy:
 *   - `finalize-init` empty mode (no `content`) refuses to overwrite a
 *     non-empty `PROJECT.md`; content mode is an intentional authored update
 *     and always writes.
 *   - `scaffold-docs` writes each of the three docs only when missing or
 *     effectively empty, and refuses (skips) any that already has real content.
 */

import { randomBytes } from 'node:crypto';
import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  rename as fsRename,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  defineTool,
  type ExtensionContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { docTargetPath, readTemplate, type DocName } from './templates.js';

/**
 * Minimal filesystem surface the tools depend on. Injectable so tests can
 * simulate a mid-write failure (a throwing `writeFile`) and assert no
 * half-written doc is left behind.
 */
export interface InitFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  unlink(path: string): Promise<void>;
}

export const defaultInitFs: InitFs = {
  readFile: (path, encoding) => fsReadFile(path, encoding),
  writeFile: (path, data, encoding) => fsWriteFile(path, data, encoding),
  rename: (oldPath, newPath) => fsRename(oldPath, newPath),
  mkdir: (path, options) => fsMkdir(path, options),
  unlink: (path) => fsUnlink(path),
};

/**
 * A doc is safe to write when it does not exist or is effectively empty
 * (whitespace only). Any real content makes it non-empty and clobber-protected.
 */
async function isEffectivelyEmpty(fs: InitFs, path: string): Promise<boolean> {
  try {
    const current = await fs.readFile(path, 'utf8');
    return current.trim().length === 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Missing file counts as empty/writable.
      return true;
    }
    throw err;
  }
}

/**
 * Write `content` to `path` atomically: write a sibling temp file, then rename
 * it over the target. A failure before the rename leaves the target untouched;
 * the temp file is removed best-effort so no scratch file lingers.
 */
async function atomicWrite(
  fs: InitFs,
  path: string,
  content: string,
): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true });
  try {
    await fs.writeFile(tmp, content, 'utf8');
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  // Atomicity here means no torn/partial target file, not crash durability.
  try {
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

function simpleResult(text: string, details: unknown) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
  };
}

/**
 * `finalize-init`: the sole writer of `docs/PROJECT.md`.
 *
 * Empty mode (no `content`): scaffold the empty PROJECT template, refusing to
 * clobber a PROJECT.md that already has real content.
 * Content mode (`content` provided): write/update PROJECT.md with the authored
 * markdown. This is an intentional update and always writes.
 */
export function toolFinalizeInit(fs: InitFs = defaultInitFs): ToolDefinition {
  return defineTool({
    name: 'finalize-init',
    label: 'Finalize Init',
    description:
      'Write or update docs/PROJECT.md only. With no content, scaffold the empty PROJECT template and refuse to clobber a non-empty PROJECT.md. With content, write the authored PROJECT.md (an intentional update). Writes atomically; runs no review loop and touches no other doc.',
    promptSnippet:
      'Call finalize-init with the authored PROJECT.md markdown after a short /init interview, or with no content to scaffold an empty PROJECT.md.',
    promptGuidelines: [
      'Pass the exact PROJECT.md markdown you want written as content; omit content to scaffold the empty template.',
      'Empty mode refuses to overwrite a PROJECT.md that already has real content; report that and stop rather than forcing it.',
      'This tool writes only docs/PROJECT.md. It never touches REQUIREMENTS/ROADMAP/STATE; use scaffold-docs for those.',
    ],
    parameters: Type.Object({
      content: Type.Optional(Type.String()),
    }),
    renderCall() {
      return new Text('docs/PROJECT.md', 0, 0);
    },
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const hasContent = Object.prototype.hasOwnProperty.call(
        params,
        'content',
      );
      const rawContent = params.content as string | undefined;
      const path = docTargetPath(ctx.cwd, 'PROJECT');

      if (!hasContent) {
        // Empty mode: scaffold template, refuse to clobber real content.
        if (!(await isEffectivelyEmpty(fs, path))) {
          return simpleResult(
            'Cannot scaffold docs/PROJECT.md: it already has content. Empty mode refuses to clobber a non-empty PROJECT.md. Run /init "<goal>" to author an update instead.',
            { ok: false, reason: 'would-clobber', path: 'docs/PROJECT.md' },
          );
        }
        const template = await readTemplate('PROJECT');
        await atomicWrite(fs, path, template);
        return simpleResult('Scaffolded empty docs/PROJECT.md.', {
          ok: true,
          mode: 'empty',
          path: 'docs/PROJECT.md',
        });
      }

      if (rawContent === undefined || rawContent.trim().length === 0) {
        return simpleResult(
          'Cannot write docs/PROJECT.md: content mode needs real markdown. To scaffold the empty PROJECT template, omit content entirely.',
          { ok: false, reason: 'blank-content', path: 'docs/PROJECT.md' },
        );
      }

      // Content mode: intentional authored write/update.
      const markdown = rawContent.endsWith('\n')
        ? rawContent
        : `${rawContent}\n`;
      await atomicWrite(fs, path, markdown);
      return simpleResult('Wrote docs/PROJECT.md.', {
        ok: true,
        mode: 'content',
        path: 'docs/PROJECT.md',
      });
    },
  });
}

const SCAFFOLD_DOCS: readonly Exclude<DocName, 'PROJECT'>[] = [
  'REQUIREMENTS',
  'ROADMAP',
  'STATE',
];

/**
 * `scaffold-docs`: write the empty REQUIREMENTS/ROADMAP/STATE ledger templates.
 *
 * Each doc is written only when missing or effectively empty; a doc that
 * already has real content is skipped (never clobbered). Each doc is written
 * per-doc-atomically (temp+rename), but the three-doc operation is not
 * transactional: a mid-run failure may leave an earlier doc written. That is
 * safe because scaffold-docs is idempotent and skips docs that already have
 * content, so re-running completes the scaffold.
 * Wired to `/plan` no-arg as the mechanical bootstrap of the living ledger.
 */
export function toolScaffoldDocs(fs: InitFs = defaultInitFs): ToolDefinition {
  return defineTool({
    name: 'scaffold-docs',
    label: 'Scaffold Docs',
    description:
      'Write empty docs/REQUIREMENTS.md, docs/ROADMAP.md, and docs/STATE.md from templates. Each doc is written only when missing or empty; a doc with real content is skipped, never clobbered. Writes atomically; runs no review loop.',
    promptSnippet:
      'Call scaffold-docs to bootstrap the empty REQUIREMENTS/ROADMAP/STATE ledger docs. It skips any doc that already has content.',
    promptGuidelines: [
      'This tool writes only the REQUIREMENTS/ROADMAP/STATE trio; PROJECT.md is owned by finalize-init.',
      'It refuses to clobber a doc that already has real content and reports which docs it wrote vs. skipped.',
    ],
    parameters: Type.Object({}),
    renderCall() {
      return new Text('docs/{REQUIREMENTS,ROADMAP,STATE}.md', 0, 0);
    },
    async execute(_id, _params, _signal, _onUpdate, ctx: ExtensionContext) {
      const written: string[] = [];
      const skipped: string[] = [];
      for (const name of SCAFFOLD_DOCS) {
        const path = docTargetPath(ctx.cwd, name);
        const rel = `docs/${name}.md`;
        if (await isEffectivelyEmpty(fs, path)) {
          await atomicWrite(fs, path, await readTemplate(name));
          written.push(rel);
        } else {
          skipped.push(rel);
        }
      }
      const parts: string[] = [];
      parts.push(
        written.length > 0
          ? `Scaffolded ${written.join(', ')}.`
          : 'Scaffolded nothing new.',
      );
      if (skipped.length > 0) {
        parts.push(`Left existing ${skipped.join(', ')} untouched.`);
      }
      return simpleResult(parts.join(' '), {
        ok: true,
        written,
        skipped,
      });
    },
  });
}
