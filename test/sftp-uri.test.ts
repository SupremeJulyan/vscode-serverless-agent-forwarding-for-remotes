import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRemotePathInsideRoot, normalizeRemotePath, parseRemoteUri, remoteUri,
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

test('uses a case-insensitive-safe authority for ASCII mount names', () => {
  const uri = remoteUri('gkn', '/home/alice');
  assert.equal(uri, 'serverless-sftp://m-676b6e/home/alice');
  assert.deepEqual(parseRemoteUri(uri), {
    mountName: 'gkn',
    remotePath: '/home/alice'
  });
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

test('resolves dot and relative roots through the server realpath result', () => {
  assert.equal(resolvedRemoteRoot('.', '/home/alice'), '/home/alice');
  assert.equal(resolvedRemoteRoot('projects/app', '/home/alice/projects/app'), '/home/alice/projects/app');
  assert.equal(resolvedRemoteRoot('/srv/app/', '/ignored'), '/srv/app/');
});

test('rejects malformed or unrelated remote URIs', () => {
  assert.throws(() => parseRemoteUri('file:///srv/project'), /Unsupported remote URI scheme/);
  assert.throws(() => parseRemoteUri('serverless-sftp://project/srv'), /Invalid remote URI authority/);
  assert.throws(
    () => parseRemoteUri(`${remoteUri('project', '/srv')}?secret=value`),
    /Invalid remote workspace URI/
  );
});
