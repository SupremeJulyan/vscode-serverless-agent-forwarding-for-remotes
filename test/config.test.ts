import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureConfigFile, expandHome, parseConfig, resolveMount } from '../src/config';

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

test('creates a minimal config without overwriting an existing config', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverless-remote-'));
  const configPath = path.join(directory, 'nested', 'config.json');

  assert.equal(await ensureConfigFile(configPath), configPath);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { hosts: [], mounts: [] });

  await writeFile(configPath, '{"hosts":["keep-me"]}\n');
  await ensureConfigFile(configPath);
  assert.equal(await readFile(configPath, 'utf8'), '{"hosts":["keep-me"]}\n');
});
