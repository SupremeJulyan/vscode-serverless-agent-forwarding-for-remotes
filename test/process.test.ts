import assert from 'node:assert/strict';
import test from 'node:test';
import { executeWithStdin } from '../src/process';

test('passes stdin and waits for the command to finish', async () => {
  let stdout = '';
  await executeWithStdin(
    {
      command: process.execPath,
      args: ['-e', "process.stdin.on('data', chunk => process.stdout.write(chunk))"],
      stdin: 'hello'
    },
    { stdout: (chunk) => { stdout += chunk; } }
  );
  assert.equal(stdout, 'hello');
});

test('reports the command error without replacing it with an outer timeout', async () => {
  await assert.rejects(
    executeWithStdin(
      {
        command: process.execPath,
        args: ['-e', "process.stderr.write('mount failed'); process.exit(2)"],
        stdin: ''
      }
    ),
    /mount failed/
  );
});
