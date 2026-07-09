import assert from 'node:assert';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  defaultInitFs,
  toolFinalizeInit,
  toolScaffoldDocs,
  type InitFs,
} from './init-tools.js';

function firstText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const item = result.content[0];
  return item && item.type === 'text' ? (item.text ?? '') : '';
}

function ctx(cwd: string) {
  return { cwd } as never;
}

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-init-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * finalize-init
 * ------------------------------------------------------------------ */

test('finalize-init: metadata scopes the writer to PROJECT.md only', () => {
  const tool = toolFinalizeInit();
  assert.ok(tool.description?.includes('docs/PROJECT.md'));
  assert.ok(
    tool.promptGuidelines?.some((line) =>
      line.includes('never touches REQUIREMENTS/ROADMAP/STATE'),
    ),
  );
});

test('finalize-init: empty mode scaffolds the PROJECT template', async () => {
  await withTmp(async (dir) => {
    const tool = toolFinalizeInit();
    const result = await tool.execute('1', {}, undefined, undefined, ctx(dir));

    const written = await readFile(join(dir, 'docs', 'PROJECT.md'), 'utf8');
    assert.ok(written.includes('# Project'));
    assert.ok(written.includes('## Mission'));
    assert.deepStrictEqual((result.details as { mode: string }).mode, 'empty');
    assert.ok(firstText(result).includes('Scaffolded empty docs/PROJECT.md'));
  });
});

test('finalize-init: empty mode refuses to clobber a non-empty PROJECT.md', async () => {
  await withTmp(async (dir) => {
    await writeFile(join(dir, 'docs', '.keep'), '', 'utf8').catch(() => {});
    // ensure docs/ exists then write real content
    const tool = toolFinalizeInit();
    await tool.execute(
      '1',
      { content: '# Project\n\nReal mission.\n' },
      undefined,
      undefined,
      ctx(dir),
    );

    const before = await readFile(join(dir, 'docs', 'PROJECT.md'), 'utf8');
    const result = await tool.execute('2', {}, undefined, undefined, ctx(dir));
    const after = await readFile(join(dir, 'docs', 'PROJECT.md'), 'utf8');

    assert.strictEqual(before, after, 'PROJECT.md must be left untouched');
    assert.strictEqual((result.details as { ok: boolean }).ok, false);
    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'would-clobber',
    );
  });
});

test('finalize-init: empty mode overwrites a whitespace-only PROJECT.md', async () => {
  await withTmp(async (dir) => {
    const tool = toolFinalizeInit();
    // Seed a whitespace-only doc; it counts as empty and is safe to overwrite.
    await tool.execute(
      '1',
      { content: '# Project\n' },
      undefined,
      undefined,
      ctx(dir),
    );
    await writeFile(join(dir, 'docs', 'PROJECT.md'), '   \n\n', 'utf8');

    const result = await tool.execute('2', {}, undefined, undefined, ctx(dir));
    const written = await readFile(join(dir, 'docs', 'PROJECT.md'), 'utf8');

    assert.ok(written.includes('## Mission'));
    assert.strictEqual((result.details as { ok: boolean }).ok, true);
  });
});

test('finalize-init: content mode writes and overwrites PROJECT.md only', async () => {
  await withTmp(async (dir) => {
    const tool = toolFinalizeInit();
    await tool.execute(
      '1',
      { content: '# Project\n\nFirst mission.\n' },
      undefined,
      undefined,
      ctx(dir),
    );
    const result = await tool.execute(
      '2',
      { content: '# Project\n\nUpdated mission.' },
      undefined,
      undefined,
      ctx(dir),
    );

    const written = await readFile(join(dir, 'docs', 'PROJECT.md'), 'utf8');
    assert.ok(written.includes('Updated mission.'));
    assert.ok(written.endsWith('\n'), 'trailing newline is normalized');
    assert.strictEqual((result.details as { mode: string }).mode, 'content');

    // No sibling ledger docs were created.
    assert.strictEqual(
      await exists(join(dir, 'docs', 'REQUIREMENTS.md')),
      false,
    );
    assert.strictEqual(await exists(join(dir, 'docs', 'ROADMAP.md')), false);
    assert.strictEqual(await exists(join(dir, 'docs', 'STATE.md')), false);
  });
});

test('finalize-init: blank/whitespace content is rejected', async () => {
  await withTmp(async (dir) => {
    const tool = toolFinalizeInit();
    const result = await tool.execute(
      '1',
      { content: '   \n  ' },
      undefined,
      undefined,
      ctx(dir),
    );

    assert.strictEqual((result.details as { ok: boolean }).ok, false);
    assert.strictEqual(
      (result.details as { reason: string }).reason,
      'blank-content',
    );
    assert.ok(firstText(result).includes('content mode needs real markdown'));
    assert.strictEqual(await exists(join(dir, 'docs', 'PROJECT.md')), false);
  });
});

test('finalize-init: writeFile failure cleans up temp file', async () => {
  await withTmp(async (dir) => {
    // Seed a real PROJECT.md via the normal path.
    await toolFinalizeInit().execute(
      '1',
      { content: '# Project\n\nOriginal.\n' },
      undefined,
      undefined,
      ctx(dir),
    );
    const path = join(dir, 'docs', 'PROJECT.md');
    const original = await readFile(path, 'utf8');

    // Injected fs writes the temp file, then throws before rename: the original
    // doc must survive and the cleanup path must remove the temp file.
    const failingFs: InitFs = {
      ...defaultInitFs,
      async writeFile(tmpPath, data, encoding) {
        await defaultInitFs.writeFile(tmpPath, data, encoding);
        throw new Error('disk full after temp write');
      },
    };
    const tool = toolFinalizeInit(failingFs);
    await assert.rejects(
      tool.execute(
        '2',
        { content: '# Project\n\nShould not land.\n' },
        undefined,
        undefined,
        ctx(dir),
      ),
      /disk full after temp write/,
    );

    assert.strictEqual(
      await readFile(path, 'utf8'),
      original,
      'original PROJECT.md must be intact',
    );
    const leftovers = (await readdir(join(dir, 'docs'))).filter((n) =>
      n.includes('.tmp'),
    );
    assert.deepStrictEqual(leftovers, [], 'no .tmp scratch file may linger');
  });
});

test('finalize-init: rename failure cleans up temp file', async () => {
  await withTmp(async (dir) => {
    // Seed a real PROJECT.md via the normal path.
    await toolFinalizeInit().execute(
      '1',
      { content: '# Project\n\nOriginal.\n' },
      undefined,
      undefined,
      ctx(dir),
    );
    const path = join(dir, 'docs', 'PROJECT.md');
    const original = await readFile(path, 'utf8');

    // The temp file exists because writeFile delegates to the real fs, then
    // rename fails before the target is replaced.
    const failingFs: InitFs = {
      ...defaultInitFs,
      rename: () => Promise.reject(new Error('rename failed')),
    };
    const tool = toolFinalizeInit(failingFs);
    await assert.rejects(
      tool.execute(
        '2',
        { content: '# Project\n\nShould not land.\n' },
        undefined,
        undefined,
        ctx(dir),
      ),
      /rename failed/,
    );

    assert.strictEqual(
      await readFile(path, 'utf8'),
      original,
      'original PROJECT.md must be intact',
    );
    const leftovers = (await readdir(join(dir, 'docs'))).filter((n) =>
      n.includes('.tmp'),
    );
    assert.deepStrictEqual(leftovers, [], 'no .tmp scratch file may linger');
  });
});

/* ------------------------------------------------------------------ *
 * scaffold-docs
 * ------------------------------------------------------------------ */

test('scaffold-docs: metadata scopes the writer to the ledger trio', () => {
  const tool = toolScaffoldDocs();
  assert.ok(tool.description?.includes('REQUIREMENTS.md'));
  assert.ok(
    tool.promptGuidelines?.some((line) =>
      line.includes('PROJECT.md is owned by finalize-init'),
    ),
  );
});

test('scaffold-docs: writes the three empty ledger docs', async () => {
  await withTmp(async (dir) => {
    const tool = toolScaffoldDocs();
    const result = await tool.execute('1', {}, undefined, undefined, ctx(dir));

    const req = await readFile(join(dir, 'docs', 'REQUIREMENTS.md'), 'utf8');
    const roadmap = await readFile(join(dir, 'docs', 'ROADMAP.md'), 'utf8');
    const state = await readFile(join(dir, 'docs', 'STATE.md'), 'utf8');
    assert.ok(req.includes('"requirements": []'));
    assert.ok(roadmap.includes('"phases": []'));
    assert.ok(state.includes('"pointer": null'));

    assert.deepStrictEqual((result.details as { written: string[] }).written, [
      'docs/REQUIREMENTS.md',
      'docs/ROADMAP.md',
      'docs/STATE.md',
    ]);
    assert.deepStrictEqual(
      (result.details as { skipped: string[] }).skipped,
      [],
    );

    // PROJECT.md is never written by scaffold-docs.
    assert.strictEqual(await exists(join(dir, 'docs', 'PROJECT.md')), false);
  });
});

test('scaffold-docs: skips docs that already have real content', async () => {
  await withTmp(async (dir) => {
    const tool = toolScaffoldDocs();
    // First scaffold everything, then hand-edit ROADMAP.md with real content.
    await tool.execute('1', {}, undefined, undefined, ctx(dir));
    const roadmapPath = join(dir, 'docs', 'ROADMAP.md');
    const authored = '# Roadmap\n\nHand-authored phase content.\n';
    await writeFile(roadmapPath, authored, 'utf8');
    // Empty out STATE.md so it re-scaffolds; leave REQUIREMENTS as-is (template).
    await writeFile(join(dir, 'docs', 'STATE.md'), '   \n', 'utf8');

    const result = await tool.execute('2', {}, undefined, undefined, ctx(dir));
    const details = result.details as {
      written: string[];
      skipped: string[];
    };

    assert.ok(details.skipped.includes('docs/ROADMAP.md'));
    assert.ok(details.skipped.includes('docs/REQUIREMENTS.md'));
    assert.ok(details.written.includes('docs/STATE.md'));
    assert.strictEqual(
      await readFile(roadmapPath, 'utf8'),
      authored,
      'authored ROADMAP.md must be preserved',
    );
  });
});

test('scaffold-docs: writes are atomic (no half-written doc on failure)', async () => {
  await withTmp(async (dir) => {
    const failingFs: InitFs = {
      ...defaultInitFs,
      writeFile: () => Promise.reject(new Error('disk full')),
    };
    const tool = toolScaffoldDocs(failingFs);
    await assert.rejects(
      tool.execute('1', {}, undefined, undefined, ctx(dir)),
      /disk full/,
    );

    // Nothing landed and no scratch files lingered.
    let entries: string[] = [];
    try {
      entries = await readdir(join(dir, 'docs'));
    } catch {
      entries = [];
    }
    assert.deepStrictEqual(
      entries.filter((n) => n.includes('.tmp')),
      [],
      'no .tmp scratch file may linger',
    );
    assert.strictEqual(
      await exists(join(dir, 'docs', 'REQUIREMENTS.md')),
      false,
    );
  });
});
