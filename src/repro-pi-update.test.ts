import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('pi update --force does not fail with self-update unavailable error', () => {
  const result = spawnSync(
    '/Users/ycm/.local/share/pnpm/bin/pi',
    ['update', '--force'],
    {
      encoding: 'utf8',
      // Run in the current directory which has yarn packageManager to trigger the pnpm root -g warning
      cwd: process.cwd(),
    },
  );

  const hasSelfUpdateError =
    result.stderr.includes('cannot self-update this installation') ||
    result.stdout.includes('cannot self-update this installation');

  assert.ok(
    !hasSelfUpdateError,
    'pi update failed with: ' + (result.stderr || result.stdout),
  );
});
