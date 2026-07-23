import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isEmptyDirectory } from '../src/directory';

test('recognizes an empty directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'serverless-remote-empty-'));
  try {
    assert.equal(await isEmptyDirectory(root), true);
    await writeFile(path.join(root, 'file.txt'), 'content');
    assert.equal(await isEmptyDirectory(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not treat a missing path or a file as an empty directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'serverless-remote-path-'));
  try {
    const file = path.join(root, 'file.txt');
    await writeFile(file, 'content');
    assert.equal(await isEmptyDirectory(file), false);
    assert.equal(await isEmptyDirectory(path.join(root, 'missing')), false);
    assert.equal(await isEmptyDirectory(path.join(root, 'missing'), true), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
