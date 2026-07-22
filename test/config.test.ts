import assert from 'node:assert/strict';
import test from 'node:test';
import { expandHome, parseConfig, resolveMount } from '../src/config';

test('parses and resolves a mount through its host reference', () => {
  const config = parseConfig({
    encrypt_passwords: true,
    hosts: [{ name: 'dev', ip: '10.0.0.2', user: 'alice', vpn: true }],
    mounts: [{ name: 'project', host: 'dev', remote_path: '/srv/project' }]
  });
  const resolved = resolveMount(config, config.mounts[0]);
  assert.equal(resolved.hostConfig.ip, '10.0.0.2');
  assert.equal(resolved.remote_terminal, 'open');
});

test('rejects a missing host reference', () => {
  assert.throws(() => parseConfig({
    hosts: [],
    mounts: [{ name: 'project', host: 'missing', remote_path: '/srv/project' }]
  }), /references missing host/);
});

test('rejects an unknown remote terminal mode', () => {
  assert.throws(() => parseConfig({
    hosts: [{ name: 'dev', ip: 'host', user: 'alice' }],
    mounts: [{ name: 'project', host: 'dev', remote_path: '/srv/project', remote_terminal: 'sometimes' }]
  }), /must be now, open, or never/);
});

test('preserves a Windows drive-letter mount path', () => {
  assert.equal(expandHome('x:'), 'X:');
});
