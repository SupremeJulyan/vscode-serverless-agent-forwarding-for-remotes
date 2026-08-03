import assert from 'node:assert/strict';
import { lstat, mkdtemp } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  ensureAgentCwdPlaceholder, ensureAgentCwdSubdirectory, safeAgentCwdName
} from '../src/agent-cwd';

test('creates a real cwd below extension storage', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-cwd-'));
  const storageRoot = path.join(temporary, 'storage');
  const result = await ensureAgentCwdPlaceholder('/home/share/project', storageRoot, 'project');
  assert.equal(result.created, true);
  assert.equal(result.localPath.startsWith(path.join(storageRoot, 'agent-cwd')), true);
  assert.equal(path.basename(result.localPath), 'project');
  assert.equal(path.basename(result.legacyLocalPath), 'workspace');
  assert.equal((await lstat(result.localPath)).isDirectory(), true);

  const repeated = await ensureAgentCwdPlaceholder('/home/share/project', storageRoot, 'project');
  assert.equal(repeated.created, false);
  assert.equal(repeated.localPath, result.localPath);
});

test('uses a readable filesystem-safe mount name below the cwd hash', () => {
  assert.equal(safeAgentCwdName('node37'), 'node37');
  assert.equal(safeAgentCwdName('计算节点 / project'), '计算节点_project');
  assert.equal(safeAgentCwdName('CON'), '_CON');
  assert.equal(safeAgentCwdName('...'), 'mount');
});

test('uses separate cwd directories for mounts with the same remote root', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-cwd-mounts-'));
  const first = await ensureAgentCwdPlaceholder('/srv/project', temporary, 'first');
  const second = await ensureAgentCwdPlaceholder('/srv/project', temporary, 'second');
  assert.notEqual(first.localPath, second.localPath);
});

test('creates a real cwd for a switched remote subdirectory', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-cwd-subdirectory-'));
  const root = await ensureAgentCwdPlaceholder('/home/user', temporary, 'home');
  const nested = await ensureAgentCwdSubdirectory(
    root.localPath, '/home/user', '/home/user/zhuyuan/project'
  );
  assert.equal(nested, path.join(root.localPath, 'zhuyuan', 'project'));
  assert.equal((await lstat(nested)).isDirectory(), true);
  await assert.rejects(
    ensureAgentCwdSubdirectory(root.localPath, '/home/user', '/home/other'),
    /outside the remote root/
  );
});
