import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { planUploads } from '../src/upload-plan';

async function tempTree(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'safs-upload-plan-'));
}

test('a file source maps to targetDir/<basename>', async () => {
  const directory = await tempTree();
  const file = path.join(directory, 'xx.exe');
  await writeFile(file, Buffer.alloc(10));
  const plan = await planUploads([file], '/remote/upload');
  assert.deepEqual(plan.files.map((item) => item.remote), ['/remote/upload/xx.exe']);
  assert.equal(plan.totalBytes, 10);
  assert.ok(plan.dirs.includes('/remote/upload'));
});

test('a directory source keeps the directory name (regression: VPN/xx.exe)', async () => {
  const directory = await tempTree();
  const vpn = path.join(directory, 'VPN');
  await mkdir(vpn);
  await writeFile(path.join(vpn, 'xx.exe'), Buffer.alloc(20));
  const plan = await planUploads([vpn], '/remote/upload');
  assert.deepEqual(plan.files.map((item) => item.remote), ['/remote/upload/VPN/xx.exe']);
  assert.equal(plan.totalBytes, 20);
  assert.ok(plan.dirs.includes('/remote/upload/VPN'));
  assert.ok(!plan.files.some((item) => item.remote.includes('/xx.exe/xx.exe')));
});

test('nested and empty directories are planned', async () => {
  const directory = await tempTree();
  const root = path.join(directory, 'app');
  await mkdir(path.join(root, 'src', 'sub'), { recursive: true });
  await mkdir(path.join(root, 'empty'));
  await writeFile(path.join(root, 'src', 'sub', 'a.txt'), 'hello');
  const plan = await planUploads([root], '/remote');
  assert.deepEqual(plan.files.map((item) => item.remote), ['/remote/app/src/sub/a.txt']);
  assert.ok(plan.dirs.includes('/remote/app'));
  assert.ok(plan.dirs.includes('/remote/app/src'));
  assert.ok(plan.dirs.includes('/remote/app/src/sub'));
  assert.ok(plan.dirs.includes('/remote/app/empty'));
});

test('mixed file and directory sources', async () => {
  const directory = await tempTree();
  const file = path.join(directory, 'a.txt');
  const folder = path.join(directory, 'docs');
  await writeFile(file, 'a');
  await mkdir(folder);
  await writeFile(path.join(folder, 'b.md'), 'b');
  const plan = await planUploads([file, folder], '/remote');
  assert.deepEqual(plan.files.map((item) => item.remote).sort(), [
    '/remote/a.txt',
    '/remote/docs/b.md'
  ]);
  assert.equal(plan.totalBytes, 2);
});
