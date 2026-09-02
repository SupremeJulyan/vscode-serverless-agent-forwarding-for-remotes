import assert from 'node:assert/strict';
import * as path from 'node:path';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import test from 'node:test';
import {
  isLocalPathInside, localPathForAgent, localPathFromAgent,
  validateLocalDownloadTarget, validateLocalUploadSource
} from '../src/local-transfer-path';

test('local transfer paths translate between Windows hosts and WSL Agents', () => {
  assert.equal(
    localPathFromAgent('/mnt/c/Users/name/staging/file.bin', 'wsl', 'win32'),
    'C:\\Users\\name\\staging\\file.bin'
  );
  assert.equal(
    localPathForAgent('C:\\Users\\name\\staging\\file.bin', 'wsl', 'win32'),
    '/mnt/c/Users/name/staging/file.bin'
  );
  assert.equal(localPathFromAgent('/tmp/file', 'linux', 'linux'), '/tmp/file');
});

test('local transfer paths stay inside the automatic Agent staging root', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'safs-local-transfer-'));
  const root = path.join(base, 'agent-cwd');
  const outside = path.join(base, 'outside');
  await Promise.all([mkdir(root), mkdir(outside)]);
  const source = path.join(root, 'source.bin');
  await writeFile(source, 'bytes');
  assert.equal(await validateLocalUploadSource(root, source), source);
  assert.equal(
    await validateLocalDownloadTarget(root, path.join(root, 'nested', 'target.bin')),
    path.join(root, 'nested', 'target.bin')
  );
  assert.equal(isLocalPathInside(root, outside), false);
  await assert.rejects(validateLocalUploadSource(root, path.join(outside, 'secret')));
  await assert.rejects(validateLocalDownloadTarget(root, path.join(outside, 'target')));
});

test('local transfer validation rejects symlink escapes', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'safs-local-transfer-link-'));
  const root = path.join(base, 'agent-cwd');
  const outside = path.join(base, 'outside');
  await Promise.all([mkdir(root), mkdir(outside)]);
  const outsideFile = path.join(outside, 'secret');
  await writeFile(outsideFile, 'secret');
  const fileLink = path.join(root, 'source-link');
  const dirLink = path.join(root, 'target-link');
  const danglingLink = path.join(root, 'dangling-link');
  await symlink(outsideFile, fileLink);
  await symlink(outside, dirLink, 'dir');
  await symlink(path.join(outside, 'missing'), danglingLink);
  await assert.rejects(validateLocalUploadSource(root, fileLink), /符号链接|超出/);
  await assert.rejects(
    validateLocalDownloadTarget(root, path.join(dirLink, 'target.bin')),
    /符号链接|超出/
  );
  await assert.rejects(
    validateLocalDownloadTarget(root, danglingLink),
    /符号链接|超出/
  );
});
