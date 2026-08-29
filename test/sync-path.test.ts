import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { assertLocalSyncPath, localPathForRemote } from '../src/sync-path';

test('localPathForRemote keeps materialized paths below the sync root', () => {
  const root = path.join(os.tmpdir(), 'sync-root');
  assert.equal(localPathForRemote(root, 'dir/file.txt'), path.join(root, 'dir', 'file.txt'));
  assert.throws(() => localPathForRemote(root, '../../escape'), /escapes the local sync root/);
});

test('assertLocalSyncPath rejects linked parents and optionally exposes a linked leaf', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'safs-sync-path-'));
  const root = path.join(parent, 'root');
  const outside = path.join(parent, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, path.join(root, 'linked-dir'));
  await symlink(path.join(outside, 'secret'), path.join(root, 'linked-file'));

  await assert.rejects(
    assertLocalSyncPath(root, path.join(root, 'linked-dir', 'file')),
    /Symbolic links are not supported/
  );
  await assert.rejects(
    assertLocalSyncPath(root, path.join(root, 'linked-file')),
    /Symbolic links are not supported/
  );
  await assert.doesNotReject(
    assertLocalSyncPath(root, path.join(root, 'linked-file'), true)
  );
});
