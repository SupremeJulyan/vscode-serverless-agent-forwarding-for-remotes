import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { SyncCoordinator } from '../src/sync-coordination';

test('only one coordinator owns a sync task and readiness is shared', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safs-sync-coordination-'));
  const first = new SyncCoordinator(root);
  const second = new SyncCoordinator(root);
  assert.equal(await first.acquire('dev', '/srv/project'), true);
  assert.equal(await second.acquire('dev', '/srv/project'), false);
  assert.equal(await second.isReady('dev', '/srv/project', '/tmp/project-a'), false);
  await first.markReady('dev', '/srv/project', '/tmp/project-a');
  assert.equal(await second.isReady('dev', '/srv/project', '/tmp/project-a'), true);
  assert.equal(await second.isReady('dev', '/srv/project', '/tmp/project-b'), false);
  await first.release('dev', '/srv/project');
  assert.equal(await second.acquire('dev', '/srv/project'), true);
  await second.dispose();
});

test('clearing readiness is visible to other coordinators', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safs-sync-ready-'));
  const first = new SyncCoordinator(root);
  const second = new SyncCoordinator(root);
  await first.markReady('dev', '/srv/project', '/tmp/project');
  await second.clearReady('dev', '/srv/project', '/tmp/project');
  assert.equal(await first.isReady('dev', '/srv/project', '/tmp/project'), false);
});

test('stop requests are shared and can be cleared when restarting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safs-sync-stop-'));
  const first = new SyncCoordinator(root);
  const second = new SyncCoordinator(root);
  await first.requestStop('dev', '/srv/project');
  assert.equal(await second.isStopRequested('dev', '/srv/project'), true);
  await second.clearStop('dev', '/srv/project');
  assert.equal(await first.isStopRequested('dev', '/srv/project'), false);
});

test('reclaims locks from dead owners but never from live processes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safs-sync-lock-'));
  const coordinator = new SyncCoordinator(root);
  // key 派生与 SyncCoordinator 一致：sha256(mount\0remote) 前 24 位。
  const lockPath = path.join(root, `${createHash('sha256')
    .update('dev').update('\0').update('/srv/project').digest('hex').slice(0, 24)}.lock`);
  // 用测试进程自身 PID 模拟“其他窗口还活着”（kill 自身跨平台必成功）。
  await writeFile(lockPath, `${process.pid}-foreign\n`, { mode: 0o600 });
  assert.equal(await coordinator.acquire('dev', '/srv/project'), false);
  // 死进程（kill 报 ESRCH）：锁应被回收并成功接管，接管后写入自己的 token。
  await writeFile(lockPath, '999999999-dead\n', { mode: 0o600 });
  assert.equal(await coordinator.acquire('dev', '/srv/project'), true);
  assert.match((await readFile(lockPath, 'utf8')).trim(), /^\d+-[0-9a-f]+$/);
  await coordinator.dispose();
});
