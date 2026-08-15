import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import {
  commandExists, commandSearchPath, executeCaptured, executeWithStdin,
  resolveExecutable, windowsCommandInvocation
} from '../src/process';

test('searches ~/.local/bin before the inherited extension-host PATH', () => {
  assert.equal(
    commandSearchPath('/home/alice', '/usr/bin:/bin'),
    `${path.join('/home/alice', '.local', 'bin')}${path.delimiter}/usr/bin:/bin`
  );
});

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

test('wraps .cmd/.bat shims through cmd.exe on Windows', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only');
  const invocation = windowsCommandInvocation(
    'codex.cmd', ['mcp', 'get', 'safs']
  );
  assert.equal(invocation.command, 'cmd.exe');
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(invocation.args[3], 'codex.cmd mcp get safs');
  assert.equal(invocation.windowsVerbatimArguments, true);
});

test('quotes cmd arguments containing spaces or metacharacters', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only');
  const invocation = windowsCommandInvocation('codex.cmd', [
    'add', 'safs', '--url', 'http://127.0.0.1:9848/safs?token=a&b'
  ]);
  assert.equal(
    invocation.args[3],
    'codex.cmd add safs --url "http://127.0.0.1:9848/safs?token=a&b"'
  );
});

test('leaves direct executables untouched on Windows', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only');
  const invocation = windowsCommandInvocation('ssh', ['-V']);
  assert.equal(invocation.command, 'ssh');
  assert.deepEqual(invocation.args, ['-V']);
  assert.equal(invocation.windowsVerbatimArguments, false);
});

test('resolveExecutable returns a real path for npm .cmd shims', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only');
  if (!(await commandExists('codex'))) return t.skip('codex CLI not installed');
  const resolved = await resolveExecutable('codex');
  assert.match(resolved, /\.(cmd|bat|exe|com)$/i);
});

test('executeCaptured runs npm .cmd shims on Windows', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only');
  if (!(await commandExists('codex'))) return t.skip('codex CLI not installed');
  const result = await executeCaptured({ command: 'codex', args: ['--version'] });
  assert.equal(result.exitCode, 0);
});
