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
    command: 'sshfs-bridge', args: ['mount', 'project'], cwd: '/mnt/project',
    env: { SSHFS_BRIDGE_NO_TERMINAL: '1' }, stdin: ''
  });
  assert.deepEqual(adapter.terminal(remote.hostConfig), { command: 'ssh-bridge', args: ['dev'] });
  assert.deepEqual(adapter.status(remote, '/mnt/project'), {
    command: 'mountpoint', args: ['-q', '--', '/mnt/project']
  });
  assert.deepEqual(adapter.unmount(remote, '/mnt/project'), {
    command: 'sshfs-bridge', args: ['unmount', 'project'], stdin: ''
  });
});

test('Linux builds a native SSHFS command', () => {
  const plan = createPlatformAdapter('linux').mount(remote, '/mnt/project');
  assert.equal(plan.command, 'sshfs');
  assert.deepEqual(plan.args.slice(0, 4), ['alice@10.0.0.2:/srv/project', '/mnt/project', '-p', '2222']);
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
    command: 'fusermount3', args: ['-u', '--', '/mnt/project']
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
