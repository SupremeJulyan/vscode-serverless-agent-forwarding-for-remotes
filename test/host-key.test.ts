import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { HostConfig } from '../src/config';
import {
  addTrustedHostKey, appendTrustedHostKeys, changedKeyPromptMessage,
  firstConnectionPromptMessage, sha256Fingerprint, TrustStore,
  trustedHostKeyList, verifyHostKeyWithPrompt
} from '../src/host-key';
import {
  appendKnownHostsFile, parseKeyscanLines, parseKeyscanOutput,
  verifySystemSshHostKey, HostKeyProbeResult
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

/** 每个走决策路径的测试使用独立端口，避免模块级状态（按 ip:port 隔离）串扰。 */
function hostAt(port: number): HostConfig {
  return { name: 'dev', ip: '10.0.0.2', user: 'alice', port };
}

test('first-connection prompt highlights the target host IP, port and user', () => {
  const message = firstConnectionPromptMessage(hostAt(2222), 'SHA256:abc');
  assert.ok(message.includes('⚠️ 请确认目标主机：10.0.0.2:2222'));
  assert.ok(message.includes('登录用户 alice'));
  assert.ok(message.includes('SHA256:abc'));
  assert.ok(message.includes('是否信任此密钥并继续连接？'));
});

test('changed-key prompt shows old/new fingerprints and the highlighted host IP', () => {
  const message = changedKeyPromptMessage(
    hostAt(2222), ['SHA256:old1', 'SHA256:old2'], ['SHA256:new1']
  );
  assert.ok(message.includes('⚠️ 目标主机：10.0.0.2:2222'));
  assert.ok(message.includes('旧密钥：SHA256:old1'));
  assert.ok(message.includes('SHA256:old2'));
  assert.ok(message.includes('新密钥：SHA256:new1'));
  assert.ok(message.includes('是否接受新密钥并继续连接？'));
});

test('changed-key prompt collapses long trusted key lists', () => {
  const manyOld = ['SHA256:1', 'SHA256:2', 'SHA256:3', 'SHA256:4', 'SHA256:5'];
  const message = changedKeyPromptMessage(hostAt(2222), manyOld, ['SHA256:new']);
  assert.ok(message.includes('…（共 5 个）'));
});

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

test('addTrustedHostKey appends without duplicates; appendTrustedHostKeys adds all', async () => {
  const store = memoryStore();
  await addTrustedHostKey(store, host, 'SHA256:a');
  await addTrustedHostKey(store, host, 'SHA256:b');
  await addTrustedHostKey(store, host, 'SHA256:a');
  assert.deepEqual(trustedHostKeyList(store, host), ['SHA256:a', 'SHA256:b']);
  await appendTrustedHostKeys(store, host, ['SHA256:c', 'SHA256:a']);
  assert.deepEqual(trustedHostKeyList(store, host), ['SHA256:a', 'SHA256:b', 'SHA256:c']);
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
  const host = hostAt(3001);
  const store = memoryStore();
  const prompts = {
    firstConnection: async () => 'accept' as const,
    changed: async () => { throw new Error('first connection must not prompt changed'); }
  };
  const probe = async (): Promise<HostKeyProbeResult> => ({
    probed: true, fingerprints: ['SHA256:new']
  });
  const result = await verifySystemSshHostKey(
    store, 'prompt', host, 'linux', undefined, probe, prompts
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(trustedHostKeyList(store, host), ['SHA256:new']);
});

test('verifyHostKeyWithPrompt first connection: refuse blocks', async () => {
  const host = hostAt(3002);
  const store = memoryStore();
  const prompts = {
    firstConnection: async () => 'refuse' as const,
    changed: async () => { throw new Error('first connection must not prompt changed'); }
  };
  const allowed = await verifyHostKeyWithPrompt(store, host, ['SHA256:key'], undefined, prompts);
  assert.equal(allowed, false);
  assert.deepEqual(trustedHostKeyList(store, host), []);
});

test('MobaXterm style: every new backend key prompts once and is then remembered', async () => {
  const host = hostAt(3004);
  const store = memoryStore();
  let firstPrompts = 0;
  let changedPrompts = 0;
  const prompts = {
    firstConnection: async () => {
      firstPrompts += 1;
      return 'accept' as const;
    },
    changed: async () => {
      changedPrompts += 1;
      return 'accept' as const;
    }
  };
  // 首次连接：首次弹窗。
  assert.equal(
    await verifyHostKeyWithPrompt(store, host, ['SHA256:backendA'], undefined, prompts),
    true
  );
  // 新后端：变化弹窗（每次新密钥都确认）。
  assert.equal(
    await verifyHostKeyWithPrompt(store, host, ['SHA256:backendB'], undefined, prompts),
    true
  );
  assert.equal(firstPrompts, 1);
  assert.equal(changedPrompts, 1);
  assert.deepEqual(
    trustedHostKeyList(store, host), ['SHA256:backendA', 'SHA256:backendB']
  );
  // 已确认过的后端再次出现：台账命中，不弹窗。
  assert.equal(
    await verifyHostKeyWithPrompt(store, host, ['SHA256:backendA'], undefined, prompts),
    true
  );
  assert.equal(changedPrompts, 1);
  // 另一个新后端：再次弹窗。
  assert.equal(
    await verifyHostKeyWithPrompt(store, host, ['SHA256:backendC'], undefined, prompts),
    true
  );
  assert.equal(changedPrompts, 2);
});

test('MobaXterm style: a new key on a host with an existing ledger prompts changed', async () => {
  const host = hostAt(3005);
  const store = memoryStore();
  await addTrustedHostKey(store, host, 'SHA256:old');
  let changedPrompts = 0;
  const prompts = {
    firstConnection: async () => { throw new Error('ledger non-empty must not prompt first'); },
    changed: async () => {
      changedPrompts += 1;
      return 'accept' as const;
    }
  };
  // 台账已有历史密钥，但新密钥不在其中 → 变化弹窗确认。
  assert.equal(
    await verifyHostKeyWithPrompt(store, host, ['SHA256:new1'], undefined, prompts),
    true
  );
  assert.equal(changedPrompts, 1);
  assert.deepEqual(
    trustedHostKeyList(store, host), ['SHA256:old', 'SHA256:new1']
  );
  // 拒绝变化 → 中止且不记录。
  changedPrompts = 0;
  const promptsRefuse = {
    ...prompts,
    changed: async () => {
      changedPrompts += 1;
      return 'refuse' as const;
    }
  };
  assert.equal(
    await verifyHostKeyWithPrompt(store, host, ['SHA256:new2'], undefined, promptsRefuse),
    false
  );
  assert.equal(changedPrompts, 1);
  assert.deepEqual(
    trustedHostKeyList(store, host), ['SHA256:old', 'SHA256:new1']
  );
});

test('appendKnownHostsFile writes standard known_hosts lines idempotently with 0600', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'safs-kh-'));
  const file = path.join(dir, 'known_hosts');
  const keys = [
    { host: '[10.0.0.2]:2222', type: 'ssh-ed25519', blob: 'QUFBQQ==' },
    { host: '[10.0.0.2]:2222', type: 'ssh-rsa', blob: 'QUFBQg==' }
  ];
  await appendKnownHostsFile(file, keys);
  await appendKnownHostsFile(file, keys); // 幂等
  const content = await readFile(file, 'utf8');
  assert.equal(
    content.split(/\r?\n/).filter((line) => line.trim()).length, 2
  );
  assert.ok(content.includes('[10.0.0.2]:2222 ssh-ed25519 QUFBQQ=='));
  assert.ok(content.includes('[10.0.0.2]:2222 ssh-rsa QUFBQg=='));
  assert.equal((statSync(file).mode & 0o777), 0o600);
});

test('verifySystemSshHostKey writes accepted keys into the extension known_hosts file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'safs-kh-'));
  const file = path.join(dir, 'known_hosts');
  const host = hostAt(3006);
  const store = memoryStore();
  const prompts = {
    firstConnection: async () => 'accept' as const,
    changed: async () => 'accept' as const
  };
  const probe = async (): Promise<HostKeyProbeResult> => ({
    probed: true,
    fingerprints: ['SHA256:new'],
    keys: [{ host: '10.0.0.2', type: 'ssh-ed25519', blob: 'QUFBQw==' }]
  });
  const result = await verifySystemSshHostKey(
    store, 'prompt', host, 'linux', undefined, probe, prompts, undefined, file
  );
  assert.deepEqual(result, { ok: true });
  const content = await readFile(file, 'utf8');
  assert.ok(content.includes('10.0.0.2 ssh-ed25519 QUFBQw=='));
});

test('verifySystemSshHostKey does not write the file when the key is refused', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'safs-kh-'));
  const file = path.join(dir, 'known_hosts');
  const host = hostAt(3007);
  const store = memoryStore();
  const prompts = {
    firstConnection: async () => 'refuse' as const,
    changed: async () => 'refuse' as const
  };
  const probe = async (): Promise<HostKeyProbeResult> => ({
    probed: true,
    fingerprints: ['SHA256:new'],
    keys: [{ host: '10.0.0.2', type: 'ssh-ed25519', blob: 'QUFBQw==' }]
  });
  const result = await verifySystemSshHostKey(
    store, 'prompt', host, 'linux', undefined, probe, prompts, undefined, file
  );
  assert.equal(result.ok, false);
  await assert.rejects(readFile(file, 'utf8'));
});

test('parseKeyscanLines keeps host/type/blob for known_hosts entries', () => {
  const blobA = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIFakeA').toString('base64');
  const lines = parseKeyscanLines(
    `# 10.0.0.2:2222 SSH-2.0-OpenSSH_9.6\n[10.0.0.2]:2222 ssh-ed25519 ${blobA}\n`
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].host, '[10.0.0.2]:2222');
  assert.equal(lines[0].type, 'ssh-ed25519');
  assert.equal(lines[0].blob, blobA);
});
