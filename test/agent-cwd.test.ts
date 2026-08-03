import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, realpath } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { ensureAgentCwdPlaceholder } from '../src/agent-cwd';

test('creates a directory link at the first missing path component', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-cwd-'));
  const nativeRoot = path.join(temporary, 'native');
  const storageRoot = path.join(temporary, 'storage');
  await mkdir(nativeRoot);
  const remoteLikeRoot = path.join(nativeRoot, 'home', 'share', 'project');

  // The production input is POSIX. On POSIX test hosts this temporary absolute
  // path has the same representation and exercises the real symlink behavior.
  const result = await ensureAgentCwdPlaceholder(remoteLikeRoot, storageRoot);
  assert.equal(result.created, true);
  assert.equal(result.linkPath, path.join(nativeRoot, 'home'));
  assert.equal((await lstat(result.linkPath!)).isSymbolicLink(), true);
  assert.equal(await realpath(remoteLikeRoot), path.join(result.targetPath!, 'share', 'project'));

  const repeated = await ensureAgentCwdPlaceholder(remoteLikeRoot, storageRoot);
  assert.equal(repeated.created, false);
  assert.equal(repeated.localPath, remoteLikeRoot);
});

test('does not replace an already existing cwd', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-cwd-existing-'));
  const workspace = path.join(temporary, 'workspace');
  await mkdir(workspace);
  const result = await ensureAgentCwdPlaceholder(workspace, path.join(temporary, 'storage'));
  assert.deepEqual(result, { localPath: workspace, created: false });
});
