import assert from 'node:assert/strict';
import test from 'node:test';
import { MountConfig } from '../src/config';
import { findMountForPath, findMountForPaths, remotePathForLocalPath } from '../src/mount-path';

const mounts: MountConfig[] = [
  { name: 'root', host: 'dev', remote_path: '/srv', local_path: '/mnt/project' },
  { name: 'nested', host: 'dev', remote_path: '/srv/app', local_path: '/mnt/project/app' }
];

test('matches a mount root and preserves the current child directory as cwd', () => {
  const match = findMountForPath(mounts, '/mnt/project/docs', 'wsl', (value) => value);
  assert.equal(match?.mount.name, 'root');
  assert.equal(match?.cwd, '/mnt/project/docs');
});

test('chooses the most specific mount for nested mount paths', () => {
  const match = findMountForPath(mounts, '/mnt/project/app/src', 'wsl', (value) => value);
  assert.equal(match?.mount.name, 'nested');
});

test('does not match a path that merely shares the mount prefix', () => {
  assert.equal(findMountForPath(mounts, '/mnt/project-old', 'wsl', (value) => value), undefined);
});

test('finds the first configured mount among opened workspace folders', () => {
  const match = findMountForPaths(
    mounts, ['/home/alice/ordinary', '/mnt/project/docs'], 'linux', (value) => value
  );
  assert.equal(match?.mount.name, 'root');
  assert.equal(match?.cwd, '/mnt/project/docs');
});

test('does not auto-match ordinary workspace folders', () => {
  assert.equal(
    findMountForPaths(mounts, ['/home/alice/ordinary'], 'linux', (value) => value),
    undefined
  );
});

test('maps a Windows mount child to its corresponding remote directory', () => {
  assert.equal(
    remotePathForLocalPath('/srv/project', 'X:\\', 'X:\\packages\\api', 'windows'),
    '/srv/project/packages/api'
  );
});

test('maps a native mount root to the configured remote root', () => {
  assert.equal(
    remotePathForLocalPath('/srv/project/', '/mnt/project', '/mnt/project', 'linux'),
    '/srv/project/'
  );
});

test('refuses to map a local path outside the mount', () => {
  assert.equal(
    remotePathForLocalPath('/srv/project', 'X:\\', 'Y:\\other', 'windows'),
    undefined
  );
});
