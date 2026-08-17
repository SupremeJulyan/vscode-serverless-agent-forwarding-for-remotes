import assert from 'node:assert/strict';
import test from 'node:test';
import { HostConfig } from '../src/config';
import {
  addTrustedHostKey, applyHostKeyDecision, replaceTrustedHostKeys,
  sha256Fingerprint, TrustStore, trustedHostKeyList
} from '../src/host-key';
import {
  parseKeyscanOutput, verifySystemSshHostKey, HostKeyProbeResult
} from '../src/system-ssh-host-key';

function memoryStore(initial: Record<string, unknown> = {}): TrustStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: (key, defaultValue) => (key in data ? data[key] as never : defaultValue),
    update: async (key, value) => { data[key] = value; }
  };
}

const host: HostConfig = {
  name: 'dev', ip: '10.0.0.2', user: 'alice', port: 2222
};

test('sha256Fingerprint matches OpenSSH SHA256 fingerprint format', () => {
  const blob = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBlob', 'base64');
  const fingerprint = sha256Fingerprint(blob);
  assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/);
});

test('trust ledger migrates legacy single-fingerprint strings to a list', () => {
  const store = memoryStore({
    'safs.trustedSsh2HostKeys': { '10.0.0.2:2222': 'SHA256:old' }
  });
  assert.deepEqual(trustedHostKeyList(store, host), ['SHA256:old']);
});

test('addTrustedHostKey appends without duplicates; replaceTrustedHostKeys overwrites', async () => {
  const store = memoryStore();
  await addTrustedHostKey(store, host, 'SHA256:a');
  await addTrustedHostKey(store, host, 'SHA256:b');
  await addTrustedHostKey(store, host, 'SHA256:a');
  assert.deepEqual(trustedHostKeyList(store, host), ['SHA256:a', 'SHA256:b']);
  await replaceTrustedHostKeys(store, host, ['SHA256:c']);
  assert.deepEqual(trustedHostKeyList(store, host), ['SHA256:c']);
});

test('applyHostKeyDecision: refuse blocks, accept replaces, add keeps existing keys', async () => {
  const store = memoryStore();
  await addTrustedHostKey(store, host, 'SHA256:a');
  assert.equal(await applyHostKeyDecision(store, host, 'refuse', ['SHA256:b']), false);
  assert.deepEqual(trustedHostKeyList(store, host), ['SHA256:a']);

  assert.equal(await applyHostKeyDecision(store, host, 'add', ['SHA256:b', 'SHA256:c']), true);
  assert.deepEqual(trustedHostKeyList(store, host), ['SHA256:a', 'SHA256:b', 'SHA256:c']);

  assert.equal(await applyHostKeyDecision(store, host, 'accept', ['SHA256:d']), true);
  assert.deepEqual(trustedHostKeyList(store, host), ['SHA256:d']);
});

test('parseKeyscanOutput extracts unique fingerprints from keyscan lines', () => {
  const blobA = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIFakeA').toString('base64');
  const blobB = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIFakeB').toString('base64');
  const output = [
    `# 10.0.0.2:2222 SSH-2.0-OpenSSH_9.6`,
    `10.0.0.2 ssh-ed25519 ${blobA}`,
    `10.0.0.2 ssh-ed25519 ${blobA}`, // 重复行应去重
    `10.0.0.2 ssh-rsa ${blobB}`,
    `junk line without blob`
  ].join('\n');
  const fingerprints = parseKeyscanOutput(output);
  assert.equal(fingerprints.length, 2);
  assert.ok(fingerprints.includes(sha256Fingerprint(Buffer.from(blobA, 'base64'))));
  assert.ok(fingerprints.includes(sha256Fingerprint(Buffer.from(blobB, 'base64'))));
});

test('parseKeyscanOutput ignores invalid base64 lines', () => {
  assert.deepEqual(parseKeyscanOutput('10.0.0.2 ssh-ed25519 !!!not-base64!!!'), []);
  assert.deepEqual(parseKeyscanOutput(''), []);
});

test('verifySystemSshHostKey skips verification for accept and reject modes', async () => {
  const store = memoryStore();
  const probe = async (): Promise<HostKeyProbeResult> => {
    throw new Error('should not be called');
  };
  assert.deepEqual(
    await verifySystemSshHostKey(store, 'accept', host, 'linux', undefined, probe),
    { ok: true }
  );
  assert.deepEqual(
    await verifySystemSshHostKey(store, 'reject', host, 'linux', undefined, probe),
    { ok: true }
  );
});

test('verifySystemSshHostKey passes when a probed fingerprint is already trusted', async () => {
  const store = memoryStore();
  await addTrustedHostKey(store, host, 'SHA256:known');
  const probe = async (): Promise<HostKeyProbeResult> => ({
    probed: true, fingerprints: ['SHA256:known', 'SHA256:other']
  });
  const result = await verifySystemSshHostKey(store, 'prompt', host, 'linux', undefined, probe);
  assert.deepEqual(result, { ok: true });
});

test('verifySystemSshHostKey falls back to proceed when probing fails', async () => {
  const store = memoryStore();
  const probe = async (): Promise<HostKeyProbeResult> => ({
    probed: false, fingerprints: [], error: 'ENOENT'
  });
  const result = await verifySystemSshHostKey(store, 'prompt', host, 'linux', undefined, probe);
  assert.deepEqual(result, { ok: true });
});

test('verifySystemSshHostKey first connection: trust stores the key and allows', async () => {
  const store = memoryStore();
  const probe = async (): Promise<HostKeyProbeResult> => ({
    probed: true, fingerprints: ['SHA256:new']
  });
  const prompts = {
    firstConnection: async (_h: HostConfig, fingerprint: string) => {
      assert.equal(fingerprint, 'SHA256:new');
      return 'accept' as const;
    },
    changed: async () => { throw new Error('should not prompt changed on first connect'); }
  };
  const result = await verifySystemSshHostKey(store, 'prompt', host, 'linux', undefined, probe, prompts);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(trustedHostKeyList(store, host), ['SHA256:new']);
});

test('verifySystemSshHostKey changed key: refuse blocks the connection', async () => {
  const store = memoryStore();
  await addTrustedHostKey(store, host, 'SHA256:old');
  const probe = async (): Promise<HostKeyProbeResult> => ({
    probed: true, fingerprints: ['SHA256:new']
  });
  const prompts = {
    firstConnection: async () => { throw new Error('should not prompt first connect'); },
    changed: async (_h: HostConfig, oldKeys: string[], newKeys: string[]) => {
      assert.deepEqual(oldKeys, ['SHA256:old']);
      assert.deepEqual(newKeys, ['SHA256:new']);
      return 'refuse' as const;
    }
  };
  const result = await verifySystemSshHostKey(store, 'prompt', host, 'linux', undefined, probe, prompts);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /拒绝接受/);
  assert.deepEqual(trustedHostKeyList(store, host), ['SHA256:old']);
});

test('verifySystemSshHostKey changed key: add keeps the old key for load-balanced backends', async () => {
  const store = memoryStore();
  await addTrustedHostKey(store, host, 'SHA256:old');
  const probe = async (): Promise<HostKeyProbeResult> => ({
    probed: true, fingerprints: ['SHA256:new']
  });
  const prompts = {
    firstConnection: async () => { throw new Error('should not prompt first connect'); },
    changed: async () => 'add' as const
  };
  const result = await verifySystemSshHostKey(store, 'prompt', host, 'wsl', undefined, probe, prompts);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(trustedHostKeyList(store, host), ['SHA256:old', 'SHA256:new']);
});
