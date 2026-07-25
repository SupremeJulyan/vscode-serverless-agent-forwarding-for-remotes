import assert from 'node:assert/strict';
import test from 'node:test';
import { MountConfig } from '../src/config';
import {
  defaultMountDirectory, findMountForPath, findMountForPaths, remotePathForLocalPath,
  resolveMountDirectory
} from '../src/mount-path';

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

test('default mount directories follow the current folder on Unix-like platforms', () => {
  const mount: MountConfig = { name: 'testgkn', host: 'dev', remote_path: '.' };
  for (const platform of ['wsl', 'linux', 'macos'] as const) {
    assert.equal(defaultMountDirectory(mount, '/home/julyan', platform), '/home/julyan/testgkn');
    assert.equal(defaultMountDirectory(mount, '/home/julyan/testgkn', platform), '/home/julyan/testgkn');
  }
});

test('Windows keeps the default drive-letter mount', () => {
  const mount: MountConfig = { name: 'testgkn', host: 'dev', remote_path: '.' };
  assert.equal(defaultMountDirectory(mount, 'C:\\Users\\julyan', 'windows'), 'R:\\');
});

test('keeps a configured local_path fixed when the current workspace changes', () => {
  const mount: MountConfig = {
    name: 'gkn', host: 'gkn', remote_path: '.', local_path: '/home/julyan/gkn'
  };
  for (const current of ['/home/julyan/project/one', '/home/julyan/project/two']) {
    assert.equal(
      resolveMountDirectory(mount, current, 'wsl', (value) => value),
      '/home/julyan/gkn'
    );
  }
});

test('prefers the platform-specific local path over local_path', () => {
  const mount: MountConfig = {
    name: 'gkn', host: 'gkn', remote_path: '.',
    local_path: '/mnt/shared/gkn',
    local_paths: { wsl: '/mnt/wsl/gkn' }
  };
  assert.equal(
    resolveMountDirectory(mount, '/workspace', 'wsl', (value) => value),
    '/mnt/wsl/gkn'
  );
});

test('uses a workspace-based default only when no local path is configured', () => {
  const mount: MountConfig = { name: 'gkn', host: 'gkn', remote_path: '.' };
  assert.equal(
    resolveMountDirectory(mount, '/workspace', 'wsl', (value) => value),
    '/workspace/gkn'
  );
});
