import assert from 'node:assert/strict';
import test from 'node:test';
import { DownloadEchoGuard, LocalFileFingerprint } from '../src/sync-echo';

function stat(
  size: number, mtimeMs: number, ctimeMs: number, directory = false
): LocalFileFingerprint {
  return { size, mtimeMs, ctimeMs, isDirectory: () => directory };
}

test('download echo guard absorbs the full watcher event burst', () => {
  let now = 1_000;
  const guard = new DownloadEchoGuard(10_000, () => now);
  const downloaded = stat(12, 20, 30);
  guard.record('/tmp/new.txt', downloaded);

  assert.equal(guard.matches('/tmp/new.txt', downloaded), true);
  assert.equal(guard.matches('/tmp/new.txt', downloaded), true);
  assert.equal(guard.matches('/tmp/new.txt', downloaded), true);

  now += 10_001;
  assert.equal(guard.matches('/tmp/new.txt', downloaded), false);
});

test('a real local edit invalidates the downloaded fingerprint immediately', () => {
  const guard = new DownloadEchoGuard();
  guard.record('/tmp/new.txt', stat(12, 20, 30));
  assert.equal(guard.matches('/tmp/new.txt', stat(13, 21, 31)), false);
  assert.equal(guard.matches('/tmp/new.txt', stat(12, 20, 30)), false);
});
