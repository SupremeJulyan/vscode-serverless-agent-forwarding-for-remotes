import assert from 'node:assert/strict';
import test from 'node:test';
import { executeWithStdin } from '../src/process';

test('terminates a non-interactive command when its timeout expires', async () => {
  const started = Date.now();
  await assert.rejects(
    executeWithStdin(
      {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        stdin: ''
      },
      {},
      100
    ),
    /Timed out after 1 seconds/
  );
  assert.ok(Date.now() - started < 2_000);
});

test('force kills a process group that ignores the timeout SIGTERM', async () => {
  if (process.platform === 'win32') return;
  const started = Date.now();
  await assert.rejects(
    executeWithStdin(
      {
        command: process.execPath,
        args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        stdin: ''
      },
      {},
      100
    ),
    /Timed out after 1 seconds/
  );
  assert.ok(Date.now() - started < 2_000);
});
