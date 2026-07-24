import assert from 'node:assert/strict';
import test from 'node:test';
import { ResolvedMount } from '../src/config';
import { createPlatformAdapter, detectPlatform } from '../src/platform';

const remote: ResolvedMount = {
  name: 'project', host: 'dev', remote_path: '/srv/project', local_path: '/mnt/project',
  remote_terminal: 'open',
  hostConfig: { name: 'dev', ip: '10.0.0.2', user: 'alice', port: 2222, vpn: true }
};

test('detects WSL separately from Linux', () => {
  assert.equal(detectPlatform('linux', '6.6.87.2-microsoft-standard-WSL2'), 'wsl');
  assert.equal(detectPlatform('linux', '6.8.0-generic'), 'linux');
  assert.equal(detectPlatform('darwin', '25.0.0'), 'macos');
  assert.equal(detectPlatform('win32', '10.0.0'), 'windows');
});

test('WSL delegates mount and relay handling to bridge commands', () => {
  const adapter = createPlatformAdapter('wsl');
  assert.deepEqual(adapter.mount(remote, '/mnt/project'), {
    command: 'sshfs-bridge', args: ['mount', 'project'],
    env: { SSHFS_BRIDGE_NO_TERMINAL: '1' }, stdin: ''
  });
  assert.deepEqual(adapter.terminal(remote.hostConfig), { command: 'ssh-bridge', args: ['dev'] });
  assert.deepEqual(adapter.terminal(remote.hostConfig, "/srv/project/it's here"), {
    command: 'ssh-bridge',
    args: ['--tty', 'dev', `cd -- '/srv/project/it'\"'\"'s here' && exec "\${SHELL:-/bin/sh}" -l`]
  });
  assert.deepEqual(adapter.status(remote, '/mnt/project'), {
    command: 'mountpoint', args: ['-q', '--', '/mnt/project']
  });
  assert.deepEqual(adapter.unmount(remote, '/mnt/project'), {
    command: 'sshfs-bridge', args: ['unmount', 'project'], stdin: ''
  });
});

test('WSL forwards the SSH connection-pool preference to both bridge commands', () => {
  const adapter = createPlatformAdapter('wsl');
  assert.equal(
    adapter.mount(remote, '/mnt/project', { reuseSshConnection: true })
      .env?.WSL_VPN_SSH_CONNECTION_REUSE,
    '1'
  );
  assert.equal(
    adapter.terminal(remote.hostConfig, undefined, { reuseSshConnection: false })
      .env?.WSL_VPN_SSH_CONNECTION_REUSE,
    '0'
  );
});

test('Linux builds a native SSHFS command', () => {
  const plan = createPlatformAdapter('linux').mount(remote, '/mnt/project');
  assert.equal(plan.command, 'sshfs');
  assert.deepEqual(plan.args.slice(0, 4), ['alice@10.0.0.2:/srv/project', '/mnt/project', '-p', '2222']);
});

test('native Unix can reuse one OpenSSH control connection for SSHFS and terminals', () => {
  const adapter = createPlatformAdapter('linux');
  const mountPlan = adapter.mount(remote, '/mnt/project', { reuseSshConnection: true });
  const terminalPlan = adapter.terminal(remote.hostConfig, undefined, {
    reuseSshConnection: true
  });
  for (const plan of [mountPlan, terminalPlan]) {
    assert.equal(plan.args.includes('ControlMaster=auto'), true);
    assert.equal(plan.args.includes('ControlPersist=10m'), true);
    assert.equal(plan.args.includes('ControlPath=~/.ssh/serverless-remote-%C'), true);
  }
});

test('native SSHFS exposes explicit cache freshness profiles', () => {
  const adapter = createPlatformAdapter('linux');
  const balanced = adapter.mount(remote, '/mnt/project', {
    sshfsCacheProfile: 'balanced'
  });
  assert.equal(balanced.args.includes('cache_timeout=5'), true);
  assert.equal(balanced.args.includes('entry_timeout=5'), true);

  const fast = adapter.mount(remote, '/mnt/project', { sshfsCacheProfile: 'fast' });
  assert.equal(fast.args.includes('kernel_cache'), true);
  assert.equal(fast.args.includes('cache_timeout=30'), true);

  const fresh = adapter.mount(remote, '/mnt/project', { sshfsCacheProfile: 'fresh' });
  assert.equal(fresh.args.includes('cache=no'), true);
  assert.equal(fresh.args.includes('attr_timeout=0'), true);
});

test('native SSHFS mounts the SSH login directory for a dot remote path', () => {
  const loginDirectory = { ...remote, remote_path: '.' };
  const linuxPlan = createPlatformAdapter('linux').mount(loginDirectory, '/work/dev');
  assert.equal(linuxPlan.args[0], 'alice@10.0.0.2:.');

  const windowsPlan = createPlatformAdapter('windows').mount(loginDirectory, 'R:');
  assert.deepEqual(windowsPlan.args, [
    'use', 'R:', '\\\\sshfs\\alice@10.0.0.2!2222', '/persistent:no'
  ]);
});

test('macOS checks the exact mount table entry instead of using df', () => {
  assert.deepEqual(createPlatformAdapter('macos').status(remote, '/Users/alice/project'), {
    command: '/bin/sh',
    args: ['-c', 'mount | grep -F -- " on $1 (" >/dev/null', 'sshfs-mount-check', '/Users/alice/project']
  });
});

test('native Unix platforms provide non-interactive shutdown unmount commands', () => {
  assert.deepEqual(createPlatformAdapter('macos').unmount(remote, '/Users/alice/project'), {
    command: 'umount', args: ['/Users/alice/project']
  });
  assert.deepEqual(createPlatformAdapter('linux').unmount(remote, '/mnt/project'), {
    command: 'fusermount3', args: ['-u', '--', '/mnt/project'], stdin: ''
  });
  assert.deepEqual(createPlatformAdapter('linux').lazyUnmount?.(remote, '/mnt/project'), {
    command: 'fusermount3', args: ['-uz', '--', '/mnt/project'], stdin: ''
  });
});

test('macOS SSH terminal accepts a new host key without routing the prompt through ASKPASS', () => {
  const plan = createPlatformAdapter('macos').terminal(remote.hostConfig);
  assert.deepEqual(plan.args.slice(0, 4), ['-p', '2222', '-o', 'StrictHostKeyChecking=accept-new']);
});

test('native SSH starts an interactive login shell in the mapped remote directory', () => {
  const plan = createPlatformAdapter('windows').terminal(remote.hostConfig, "/srv/project/it's here");
  assert.equal(plan.args.includes('-t'), true);
  assert.equal(plan.args.at(-1), `cd -- '/srv/project/it'\"'\"'s here' && exec "\${SHELL:-/bin/sh}" -l`);
});

test('Windows builds an SSHFS-Win root-relative UNC mapping', () => {
  const plan = createPlatformAdapter('windows').mount(remote, 'X:');
  assert.equal(plan.command, 'net');
  assert.deepEqual(plan.args, ['use', 'X:', '\\\\sshfs.r\\alice@10.0.0.2!2222\\srv\\project', '/persistent:no']);
});

test('Windows maps a password-protected login directory without an empty UNC path', () => {
  const loginDirectory = {
    ...remote,
    remote_path: '.',
    hostConfig: { ...remote.hostConfig, port: 22, password: 'secret value' }
  };
  const plan = createPlatformAdapter('windows').mount(loginDirectory, 'R:');
  assert.equal(plan.env?.SERVERLESS_REMOTE_UNC, '\\\\sshfs\\alice@10.0.0.2');
});

test('Windows passes password credentials through the environment to the network API', () => {
  const passwordRemote = { ...remote, hostConfig: { ...remote.hostConfig, password: 'secret value' } };
  const plan = createPlatformAdapter('windows').mount(passwordRemote, 'X:');
  assert.equal(plan.command, 'powershell.exe');
  assert.equal(plan.args.includes('secret value'), false);
  assert.equal(plan.args.at(-1)?.includes('WNetAddConnection2'), true);
  assert.equal(plan.env?.SERVERLESS_REMOTE_DRIVE, 'X:');
  assert.equal(plan.env?.SERVERLESS_REMOTE_UNC, '\\\\sshfs.r\\alice@10.0.0.2!2222\\srv\\project');
  assert.equal(plan.env?.SERVERLESS_REMOTE_USER, 'alice');
  assert.equal(plan.env?.SERVERLESS_REMOTE_PASSWORD, 'secret value');
  assert.equal(plan.stdin, '');
  assert.equal(plan.args.includes('secret value'), false);
});

test('Windows passes a custom private key to sshfs-win advanced mode', () => {
  const keyed = { ...remote, hostConfig: { ...remote.hostConfig, private_key_path: 'C:\\Keys\\dev' } };
  const plan = createPlatformAdapter('windows').mount(keyed, 'Y:');
  assert.equal(plan.command, 'sshfs-win.exe');
  assert.deepEqual(plan.args.slice(0, 6), [
    'cmd', 'alice@10.0.0.2:/srv/project', 'Y:', '-p', '2222', '-o'
  ]);
  assert.equal(plan.args[6], 'IdentityFile=C:\\Keys\\dev');
});
