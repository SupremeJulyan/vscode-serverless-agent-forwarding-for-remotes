import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  cleanTerminalDiagnostic, decodeTerminalDiagnostic, nextAutoReconnectAttempt,
  shouldRecoverTerminalExit, terminalDiagnosticPlan
} from '../src/terminal-diagnostics';

const plan = {
  command: 'ssh', args: ['-p', '22', 'alice@dev'], env: { KEEP: 'yes' }
};

test('Unix terminal diagnostics mirror stderr through bash without flattening arguments', () => {
  const wrapped = terminalDiagnosticPlan('linux', '/usr/bin/ssh', plan, '/tmp/safs.log');
  assert.equal(wrapped.command, '/bin/bash');
  assert.deepEqual(wrapped.args.slice(-4), ['/usr/bin/ssh', '-p', '22', 'alice@dev']);
  assert.equal(wrapped.env?.KEEP, 'yes');
  assert.equal(wrapped.env?.SAFS_TERMINAL_ERROR_LOG, '/tmp/safs.log');
  assert.match(wrapped.args[1], /tee -a/);
});

test('Windows terminal diagnostics use PowerShell and preserve native arguments', () => {
  const wrapped = terminalDiagnosticPlan('windows', 'C:\\Windows\\ssh.exe', plan, 'C:\\safs.log');
  assert.equal(wrapped.command, 'powershell.exe');
  assert.deepEqual(wrapped.args.slice(-4), [
    'C:\\Windows\\ssh.exe', '-p', '22', 'alice@dev'
  ]);
  assert.match(wrapped.args[4], /SAFS_TERMINAL_ERROR_LOG/);
});

test('terminal diagnostics strip ANSI and retain the most recent bounded output', () => {
  assert.deepEqual(cleanTerminalDiagnostic('\u001b[31mfirst\u001b[0m\r\nsecond', 8), {
    text: 't\nsecond', truncated: true
  });
});

test('terminal diagnostics decode UTF-8 and Windows PowerShell UTF-16LE output', () => {
  assert.equal(decodeTerminalDiagnostic(Buffer.from('plain', 'utf8')), 'plain');
  assert.equal(decodeTerminalDiagnostic(Buffer.concat([
    Buffer.from([0xff, 0xfe]), Buffer.from('错误', 'utf16le')
  ])), '错误');
});

test('system SSH exit 0 is recovered when automatic reconnect is enabled', () => {
  assert.equal(shouldRecoverTerminalExit({
    processExit: true,
    exitCode: 0,
    cleanExit: false,
    autoReconnect: true,
    diagnosticText: ''
  }), true);
  assert.equal(shouldRecoverTerminalExit({
    processExit: true,
    exitCode: 0,
    cleanExit: false,
    autoReconnect: false,
    diagnosticText: ''
  }), false);
});

test('terminal recovery excludes user/window closure but auto-recovers clean ssh2 exits', () => {
  const base = {
    exitCode: 1,
    cleanExit: false,
    autoReconnect: true,
    diagnosticText: 'Connection reset by peer'
  };
  assert.equal(shouldRecoverTerminalExit({ ...base, processExit: false }), false);
  assert.equal(shouldRecoverTerminalExit({
    ...base, processExit: true, cleanExit: true
  }), true);
  assert.equal(shouldRecoverTerminalExit({
    ...base,
    processExit: true,
    exitCode: 0,
    cleanExit: true,
    autoReconnect: false,
    diagnosticText: ''
  }), false);
});

test('an SSH disconnect diagnostic is recoverable even when exit code is 0', () => {
  assert.equal(shouldRecoverTerminalExit({
    processExit: true,
    exitCode: 0,
    cleanExit: false,
    autoReconnect: false,
    diagnosticText: 'client_loop: send disconnect: Broken pipe'
  }), true);
});

test('automatic reconnect attempts accumulate only for short-lived terminals', () => {
  assert.equal(nextAutoReconnectAttempt(0, 5_000, 60_000), 1);
  assert.equal(nextAutoReconnectAttempt(1, 59_999, 60_000), 2);
  assert.equal(nextAutoReconnectAttempt(2, 60_000, 60_000), 1);
  assert.equal(nextAutoReconnectAttempt(2, 10 * 60_000, 60_000), 1);
});

test('Unix wrapper mirrors stderr, persists it, and preserves the SSH exit code', {
  skip: process.platform === 'win32'
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-terminal-log-'));
  const logFile = path.join(directory, 'stderr.log');
  const wrapped = terminalDiagnosticPlan('linux', '/bin/sh', {
    command: '/bin/sh', args: ['-c', 'echo diagnostic >&2; exit 23']
  }, logFile);
  const result = spawnSync(wrapped.command, wrapped.args, {
    env: { ...process.env, ...wrapped.env }, encoding: 'utf8'
  });
  assert.equal(result.status, 23);
  assert.match(result.stderr, /diagnostic/);
  assert.match(readFileSync(logFile, 'utf8'), /diagnostic/);
});
