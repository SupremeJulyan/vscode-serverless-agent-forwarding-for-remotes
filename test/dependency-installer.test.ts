import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOsRelease, wslDependencyCommand } from '../src/dependency-installer';

test('parses quoted os-release values', () => {
  assert.deepEqual(parseOsRelease(
    'ID=ubuntu\nID_LIKE="debian"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n'
  ), {
    id: 'ubuntu', idLike: ['debian'], name: 'Ubuntu 24.04 LTS'
  });
});

test('installs the bundled WSL bridge runtime dependencies with apt', () => {
  const command = wslDependencyCommand({
    id: 'ubuntu', idLike: ['debian'], name: 'Ubuntu'
  });
  assert.match(command ?? '', /^apt update && apt install -y /);
  for (const dependency of ['openssh-client', 'python3', 'util-linux']) {
    assert.match(command ?? '', new RegExp(`\\b${dependency}\\b`));
  }
  assert.doesNotMatch(command ?? '', /sshfs|git|wsl-vpn-ssh-bridge/);
});

test('supports the package-manager families used by main', () => {
  for (const id of ['fedora', 'arch', 'opensuse', 'alpine']) {
    const command = wslDependencyCommand({ id, idLike: [], name: id }) ?? '';
    assert.match(command, /openssh/);
    assert.doesNotMatch(command, /sshpass/);
  }
  assert.equal(wslDependencyCommand({ id: 'unknown', idLike: [], name: 'Unknown' }), undefined);
});
