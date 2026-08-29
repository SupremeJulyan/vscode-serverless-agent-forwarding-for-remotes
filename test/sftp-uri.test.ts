import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSafeRemoteEntryName, isRemotePathInsideRoot, normalizeRemotePath, parseRemoteUri, remoteUri,
  resolvedRemoteRoot
} from '../src/sftp/uri';

test('round-trips remote folder names and unusual POSIX paths', () => {
  const uri = remoteUri("项目 A/O'Brien", "/srv/项目 A/O'Brien/[草稿] #1.ts");
  assert.deepEqual(parseRemoteUri(uri), {
    mountName: "项目 A/O'Brien",
    remotePath: "/srv/项目 A/O'Brien/[草稿] #1.ts"
  });
  assert.equal(uri.includes('项目'), false);
  assert.equal(uri.includes('#'), false);
});

test('uses the config name as the authority when it is URI-safe', () => {
  const uri = remoteUri('gkn', '/home/alice');
  assert.equal(uri, 'safs://gkn/home/alice');
  assert.deepEqual(parseRemoteUri(uri), {
    mountName: 'gkn',
    remotePath: '/home/alice'
  });
  // Unsafe names (uppercase/space) fall back to the legacy hex authority.
  const hex = remoteUri('My Host', '/home');
  assert.match(hex, /^safs:\/\/m-[0-9a-f]+\//);
  assert.deepEqual(parseRemoteUri(hex), { mountName: 'My Host', remotePath: '/home' });
  // Legacy hex authorities still decode (backward compatibility).
  assert.equal(parseRemoteUri('safs://m-676b6e/home/alice').mountName, 'gkn');
});

test('normalizes remote paths with POSIX rules on every local platform', () => {
  assert.equal(normalizeRemotePath('/srv/project/./src/../README.md'), '/srv/project/README.md');
  assert.throws(() => normalizeRemotePath('C:\\srv\\project'), /must be absolute/);
  assert.throws(() => normalizeRemotePath('relative/path'), /must be absolute/);
});

test('checks that agent paths remain inside the configured remote root', () => {
  assert.equal(isRemotePathInsideRoot('/srv/project', '/srv/project'), true);
  assert.equal(isRemotePathInsideRoot('/srv/project', '/srv/project/src/index.ts'), true);
  assert.equal(isRemotePathInsideRoot('/srv/project', '/srv/project-old/file'), false);
  assert.equal(isRemotePathInsideRoot('/srv/project', '/srv/project/../../etc/passwd'), false);
});

test('rejects remote directory entry names that can escape a local target', () => {
  assert.doesNotThrow(() => assertSafeRemoteEntryName('normal file.txt'));
  for (const name of ['', '.', '..', '../escape', 'dir/file', 'dir\\file', 'nul\0byte']) {
    assert.throws(() => assertSafeRemoteEntryName(name), /Unsafe remote directory entry/);
  }
});

test('resolves dot and relative roots through the server realpath result', () => {
  assert.equal(resolvedRemoteRoot('.', '/home/alice'), '/home/alice');
  assert.equal(resolvedRemoteRoot('projects/app', '/home/alice/projects/app'), '/home/alice/projects/app');
  assert.equal(resolvedRemoteRoot('/srv/app/', '/ignored'), '/srv/app/');
});

test('rejects malformed or unrelated remote URIs', () => {
  assert.throws(() => parseRemoteUri('file:///srv/project'), /Unsupported remote URI scheme/);
  assert.throws(
    () => parseRemoteUri(`${remoteUri('project', '/srv')}?secret=value`),
    /Invalid remote workspace URI/
  );
  assert.throws(
    () => parseRemoteUri('safs://user@project/srv'),
    /Invalid remote workspace URI/
  );
});
