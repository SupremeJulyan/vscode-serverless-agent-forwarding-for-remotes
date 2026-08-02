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

test('installs only util-linux for the bundled WSL bridge', () => {
  const command = wslDependencyCommand({
    id: 'ubuntu', idLike: ['debian'], name: 'Ubuntu'
  });
  assert.match(command ?? '', /^apt update && apt install -y /);
  assert.match(command ?? '', /\butil-linux\b/);
  assert.doesNotMatch(command ?? '', /openssh|python|sshpass|sshfs|git|wsl-vpn-ssh-bridge/);
});

test('supports the package-manager families used by main', () => {
  for (const id of ['fedora', 'arch', 'opensuse', 'alpine']) {
    const command = wslDependencyCommand({ id, idLike: [], name: id }) ?? '';
    assert.match(command, /util-linux/);
    assert.doesNotMatch(command, /openssh|python|sshpass/);
  }
  assert.equal(wslDependencyCommand({ id: 'unknown', idLike: [], name: 'Unknown' }), undefined);
});
