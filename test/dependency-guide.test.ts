import assert from 'node:assert/strict';
import test from 'node:test';
import { createDependencyGuide, parseOsRelease } from '../src/dependency-guide';

test('parses quoted os-release values', () => {
  assert.deepEqual(parseOsRelease('ID=ubuntu\nID_LIKE="debian"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n'), {
    id: 'ubuntu', idLike: ['debian'], name: 'Ubuntu 24.04 LTS'
  });
});

test('offers apt packages on Debian Linux', async () => {
  const guide = await createDependencyGuide(
    'linux', ['sshfs', 'fusermount3'], '/etc/os-release'
  );
  assert.ok(guide?.command);
  // The test environment is Debian; derived distributions are covered by the parser/family lookup.
  assert.match(guide.command, /^sudo apt update && sudo apt install/);
  assert.match(guide.command, /\bsshfs\b/);
  assert.equal(guide.url, undefined);
});

test('WSL guide includes distro packages and bridge installer', async () => {
  const guide = await createDependencyGuide(
    'wsl', ['ssh-bridge', 'sshfs-bridge'], '/etc/os-release'
  );
  assert.match(guide?.command ?? '', /wsl-vpn-ssh-bridge\.git/);
  assert.match(guide?.command ?? '', /\.\/install\.sh/);
  assert.equal(guide?.url, 'https://github.com/SupremeJulyan/wsl-vpn-ssh-bridge');
});

test('macOS guide links to macFUSE SSHFS instructions', async () => {
  const guide = await createDependencyGuide('macos', ['sshfs']);
  assert.match(guide?.message ?? '', /macFUSE SSHFS/);
  assert.match(guide?.url ?? '', /macfuse\/macfuse\/wiki/);
  assert.deepEqual(guide?.links?.map((link) => link.label), ['下载 macFUSE', '下载 SSHFS']);
});

test('Windows guide links to each missing filesystem dependency', async () => {
  const guide = await createDependencyGuide('windows', ['WinFsp', 'SSHFS-Win']);
  assert.deepEqual(guide?.links?.map((link) => link.label), ['下载 WinFsp', '下载 SSHFS-Win']);
  assert.ok(guide?.links?.every((link) => link.url.endsWith('/releases/latest')));
});
