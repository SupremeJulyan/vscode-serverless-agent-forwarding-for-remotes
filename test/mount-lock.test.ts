import assert from 'node:assert/strict';
import test from 'node:test';
import { MountOperationLock, normalizeMountLockKey } from '../src/mount-lock';

test('normalizes equivalent mount paths to one lock key', () => {
  assert.equal(
    normalizeMountLockKey('/mnt/project/../project', false),
    normalizeMountLockKey('/mnt/project', false)
  );
  assert.equal(
    normalizeMountLockKey('/MNT/Project', true),
    normalizeMountLockKey('/mnt/project', true)
  );
});

test('serializes operations for one mount without blocking other mounts', async () => {
  const lock = new MountOperationLock();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = lock.run('project', async () => {
    events.push('first:start');
    await firstCanFinish;
    events.push('first:end');
  });
  const second = lock.run('project', async () => {
    events.push('second');
  });
  const independent = lock.run('other', async () => {
    events.push('other');
  });

  await independent;
  assert.deepEqual(events, ['first:start', 'other']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'other', 'first:end', 'second']);
});

test('continues the mount queue after a failed operation', async () => {
  const lock = new MountOperationLock();
  const failed = lock.run('project', async () => {
    throw new Error('mount failed');
  });
  const next = lock.run('project', async () => 'unmounted');

  await assert.rejects(failed, /mount failed/);
  assert.equal(await next, 'unmounted');
});
