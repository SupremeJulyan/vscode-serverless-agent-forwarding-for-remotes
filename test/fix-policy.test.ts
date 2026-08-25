import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('mount parent opens the resolved default root without recording it as history', async () => {
  const source = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async function openDirectoryItem');
  const end = source.indexOf('async function openRemoteDirectory', start);
  const body = source.slice(start, end);
  assert.ok(body.includes('const remoteDirectory = folder.remoteRoot;'));
  assert.equal(body.includes('cachedRemoteDirectory'), false);
  assert.equal(body.includes('recordDirectoryHistory'), false);
});

test('sync ownership retries silently and SFTP negotiation has a bounded timeout', async () => {
  const sync = await readFile(new URL('../src/remote-sync.ts', import.meta.url), 'utf8');
  assert.equal(sync.includes('同步任务由另一个 VS Code 窗口管理'), false);
  assert.ok(sync.includes('pendingAcquireTimers'));

  const sftp = await readFile(new URL('../src/sftp/client.ts', import.meta.url), 'utf8');
  assert.ok(sftp.includes('const sftpHandshakeTimeoutMs = 15_000'));
  assert.ok(sftp.includes('SFTP 版本协商超时'));
});
