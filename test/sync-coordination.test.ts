import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
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
  assert.equal(await second.isReady('dev', '/srv/project'), false);
  await first.markReady('dev', '/srv/project');
  assert.equal(await second.isReady('dev', '/srv/project'), true);
  await first.release('dev', '/srv/project');
  assert.equal(await second.acquire('dev', '/srv/project'), true);
  await second.dispose();
});

test('clearing readiness is visible to other coordinators', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safs-sync-ready-'));
  const first = new SyncCoordinator(root);
  const second = new SyncCoordinator(root);
  await first.markReady('dev', '/srv/project');
  await second.clearReady('dev', '/srv/project');
  assert.equal(await first.isReady('dev', '/srv/project'), false);
});
