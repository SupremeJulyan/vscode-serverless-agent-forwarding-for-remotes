import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { HostConfig } from '../src/config';
import { createPlatformAdapter, detectPlatform } from '../src/platform';

// Stub WSL bundle path so platform.ts resolves ssh-bridge without a VS Code
// extension context. Uses dynamic import to avoid compile-time vscode dep.
let bundlePath: string;
test.before(async () => {
  const { setWslBundlePath } = await import('../src/wsl-bridge');
  bundlePath = mkdtempSync(path.join(os.tmpdir(), 'serverless-test-wsl-'));
  setWslBundlePath(path.join(bundlePath, 'resources', 'wsl'));
});

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
  const plan = createPlatformAdapter('linux').terminal(host, "/srv/O'Brien", {
    reuseSshConnection: true
  });
  assert.equal(plan.command, 'ssh');
  assert.equal(plan.cwd, undefined);
  assert.equal(plan.args.some((argument) => argument.endsWith('/.ssh/id_ed25519')), true);
  assert.equal(plan.args.includes('ControlMaster=auto'), true);
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

test('WSL uses bundled ssh-bridge for terminals and command execution', () => {
  const adapter = createPlatformAdapter('wsl');
  const terminal = adapter.terminal(host, '/srv/project');
  const execution = adapter.exec(host, '/srv/project', 'git status');
  assert.equal(terminal.command, path.join(bundlePath, 'resources', 'wsl', 'ssh-bridge'));
  assert.equal(terminal.cwd, undefined);
  assert.equal(execution.command, path.join(bundlePath, 'resources', 'wsl', 'ssh-bridge'));
  assert.equal(terminal.args.includes('--tty'), true);
  assert.equal(terminal.env?.WSL_VPN_SSH_CONNECTION_REUSE, '1');
  assert.match(execution.args.at(-1) ?? '', /git status/);
});

test('WSL enables connection reuse for terminals and background commands', () => {
  const adapter = createPlatformAdapter('wsl');
  const terminal = adapter.terminal(host, '/srv/project', { reuseSshConnection: true });
  const execution = adapter.exec(host, '/srv/project', 'pwd', { reuseSshConnection: true });
  assert.equal(terminal.env?.WSL_VPN_SSH_CONNECTION_REUSE, '1');
  assert.equal(execution.env?.WSL_VPN_SSH_CONNECTION_REUSE, '1');
});

test('connection reuse can be disabled for native and WSL terminals', () => {
  const native = createPlatformAdapter('windows').terminal(host, '/srv/project', {
    reuseSshConnection: false
  });
  const wsl = createPlatformAdapter('wsl').terminal(host, '/srv/project', {
    reuseSshConnection: false
  });
  assert.equal(native.args.includes('ControlMaster=auto'), false);
  assert.equal(wsl.env?.WSL_VPN_SSH_CONNECTION_REUSE, '0');
});

test('WSL passes the selected config path to terminal and command bridges', () => {
  const adapter = createPlatformAdapter('wsl');
  const options = { bridgeConfigPath: '/home/alice/.safs/config.json' };
  assert.equal(
    adapter.terminal(host, '/srv/project', options).env?.WSL_VPN_SSH_CONFIG,
    options.bridgeConfigPath
  );
  assert.equal(
    adapter.exec(host, '/srv/project', 'pwd', options).env?.WSL_VPN_SSH_CONFIG,
    options.bridgeConfigPath
  );
});

test('WSL resolves the VPN relay pool helper from the extension bundle', async () => {
  const { vpnRelayPoolPath } = await import('../src/wsl-bridge');
  assert.equal(
    vpnRelayPoolPath(),
    path.join(bundlePath, 'resources', 'wsl', 'vpn-relay-pool.sh')
  );
});

test('WSL passes the master password to ssh-bridge terminal environment only', () => {
  const plan = createPlatformAdapter('wsl').terminal(host, '/srv/project', {
    bridgeMasterPassword: 'master secret'
  });
  assert.equal(plan.env?.WSL_VPN_MASTER_PASSWORD, 'master secret');
  assert.equal(plan.args.includes('master secret'), false);
});

test('WSL never passes the decrypted SSH password through the bridge environment', () => {
  const plan = createPlatformAdapter('wsl').terminal(host, '/srv/project');
  assert.equal(plan.env?.SSH_BRIDGE_PASSWORD, undefined);
});
