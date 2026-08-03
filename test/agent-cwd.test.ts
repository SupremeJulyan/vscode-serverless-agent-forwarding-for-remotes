import assert from 'node:assert/strict';
import { lstat, mkdtemp } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { ensureAgentCwdPlaceholder } from '../src/agent-cwd';

test('creates a real cwd below extension storage', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-cwd-'));
  const storageRoot = path.join(temporary, 'storage');
  const result = await ensureAgentCwdPlaceholder('/home/share/project', storageRoot, 'project');
  assert.equal(result.created, true);
  assert.equal(result.localPath.startsWith(path.join(storageRoot, 'agent-cwd')), true);
  assert.equal((await lstat(result.localPath)).isDirectory(), true);

  const repeated = await ensureAgentCwdPlaceholder('/home/share/project', storageRoot, 'project');
  assert.equal(repeated.created, false);
  assert.equal(repeated.localPath, result.localPath);
});

test('uses separate cwd directories for mounts with the same remote root', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-cwd-mounts-'));
  const first = await ensureAgentCwdPlaceholder('/srv/project', temporary, 'first');
  const second = await ensureAgentCwdPlaceholder('/srv/project', temporary, 'second');
  assert.notEqual(first.localPath, second.localPath);
});
