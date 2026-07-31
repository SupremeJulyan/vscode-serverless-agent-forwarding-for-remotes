import assert from 'node:assert/strict';
import test from 'node:test';
import { HostConfig } from '../src/config';
import { createPlatformAdapter, detectPlatform } from '../src/platform';

const host: HostConfig = {
  name: 'dev',
  ip: '10.0.0.2',
  user: 'alice',
  port: 2222,
  private_key_path: '~/.ssh/id_ed25519'
};

test('detects WSL separately from native Linux', () => {
  assert.equal(detectPlatform('linux', '6.1-microsoft-standard-WSL2'), 'wsl');
  assert.equal(detectPlatform('linux', '6.8.0-generic'), 'linux');
});

test('native SSH opens a login shell in the remote SFTP directory', () => {
  const plan = createPlatformAdapter('linux').terminal(host, "/srv/O'Brien");
  assert.equal(plan.command, 'ssh');
  assert.equal(plan.cwd, undefined);
  assert.equal(plan.args.some((argument) => argument.endsWith('/.ssh/id_ed25519')), true);
  assert.match(plan.args.at(-1) ?? '', /cd --/);
  assert.match(plan.args.at(-1) ?? '', /O'"'"'Brien/);
});

test('native remote execution supports OpenSSH connection reuse', () => {
  const plan = createPlatformAdapter('macos').exec(host, '/srv/project', 'npm test', {
    reuseSshConnection: true
  });
  assert.equal(plan.args.includes('ControlMaster=auto'), true);
  assert.match(plan.args.at(-1) ?? '', /npm test/);
});

test('WSL keeps ssh-bridge for terminals and command execution', () => {
  const adapter = createPlatformAdapter('wsl');
  const terminal = adapter.terminal(host, '/srv/project');
  const execution = adapter.exec(host, '/srv/project', 'git status');
  assert.equal(terminal.command, 'ssh-bridge');
  assert.equal(terminal.cwd, undefined);
  assert.equal(execution.command, 'ssh-bridge');
  assert.equal(terminal.args.includes('--tty'), true);
  assert.match(execution.args.at(-1) ?? '', /git status/);
});

test('WSL passes the master password to ssh-bridge terminal environment only', () => {
  const plan = createPlatformAdapter('wsl').terminal(host, '/srv/project', {
    bridgeMasterPassword: 'master secret'
  });
  assert.equal(plan.env?.WSL_VPN_MASTER_PASSWORD, 'master secret');
  assert.equal(plan.args.includes('master secret'), false);
});
