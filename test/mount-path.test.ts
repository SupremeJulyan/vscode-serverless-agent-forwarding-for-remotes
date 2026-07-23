import assert from 'node:assert/strict';
import test from 'node:test';
import { MountConfig } from '../src/config';
import { findMountForPath } from '../src/mount-path';

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
