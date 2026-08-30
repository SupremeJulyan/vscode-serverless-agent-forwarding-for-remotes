import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { HostConfig } from '../src/config';
import {
  appendKnownHostsFile, changedKeyDecision, changedKeyPromptMessage,
  firstConnectionDecision, firstConnectionPromptMessage,
  hostEntryName, hostEntryNames, keyTypeFromBlob, readTrustedFingerprints,
  replaceKnownHostsForHost, setKnownHostsFilePath, sha256Fingerprint,
  verifyHostKeyWithPrompt
} from '../src/host-key';
import {
  isOpenSshHostKeyVerificationFailure, parseKeyscanLines, parseKeyscanOutput,
  runWithOpenSshHostKeyRetry, verifySystemSshHostKey, HostKeyProbeResult
} from '../src/system-ssh-host-key';

/** 每个测试使用独立临时 known_hosts 文件，避免模块级路径串扰。 */
function tempKnownHosts(): { file: string; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'safs-kh-'));
  return { file: path.join(dir, 'known_hosts'), dir };
}

function hostAt(port: number): HostConfig {
  return { name: 'dev', ip: '10.0.0.2', user: 'alice', port };
}

/** 直接构造 known_hosts 行（测试预置已确认密钥用）。 */
function lineFor(host: HostConfig, type: string, blob: string): string {
  return `${hostEntryName(host)} ${type} ${blob}`;
}

const blobA = 'QUFBQUNOemFoQzFsWkRJMU5URTVBQUFBSWZha2VB'; // ssh-ed25519 类型开头的假 blob
const blobB = 'QUFBQUNOemFoQzFsWkRJMU5URTVBQUFBSWZha2VC';
const blobC = 'QUFBQUNOemFoQzFsWkRJMU5URTVBQUFBSWZha2VD';

test('first-connection prompt highlights the target host IP, port and user', () => {
  const message = firstConnectionPromptMessage(hostAt(2222), ['SHA256:abc', 'SHA256:def']);
  assert.ok(message.includes('⚠️ 请确认目标主机：10.0.0.2:2222'));
  assert.ok(message.includes('登录用户 alice'));
  assert.ok(message.includes('SHA256:abc'));
  assert.ok(message.includes('SHA256:def'));
  assert.ok(message.includes('是否信任这些密钥并继续连接？'));
});

test('changed-key prompt shows old/new fingerprints and the highlighted host IP', () => {
  const message = changedKeyPromptMessage(
    hostAt(2222), ['SHA256:old1', 'SHA256:old2'], ['SHA256:new1']
  );
  assert.ok(message.includes('⚠️ 目标主机：10.0.0.2:2222'));
  assert.ok(message.includes('旧密钥：SHA256:old1'));
  assert.ok(message.includes('SHA256:old2'));
  assert.ok(message.includes('新密钥：SHA256:new1'));
  assert.ok(message.includes(
    '请选择替换旧密钥（SSH主机重装）/ 追加新密钥（SSH主机为负载节点） / 拒绝（不信任该主机）。'
  ));
});

test('changed-key prompt collapses long trusted key lists', () => {
  const manyOld = ['SHA256:1', 'SHA256:2', 'SHA256:3', 'SHA256:4', 'SHA256:5'];
  const message = changedKeyPromptMessage(hostAt(2222), manyOld, ['SHA256:new']);
  assert.ok(message.includes('…（共 5 个）'));
});

test('dialog decisions: closing with X/Esc (undefined) refuses, never accepts', () => {
  assert.equal(firstConnectionDecision('信任并连接'), 'accept');
  assert.equal(firstConnectionDecision(undefined), 'refuse');
  assert.equal(changedKeyDecision('替换旧密钥'), 'replace');
  assert.equal(changedKeyDecision('追加新密钥'), 'accept');
  assert.equal(changedKeyDecision('拒绝'), 'refuse');
  assert.equal(changedKeyDecision('拒绝新密钥并中止连接'), 'refuse');
  // 安全回归：X / Esc 关闭弹窗绝不能默认接受新密钥。
  assert.equal(changedKeyDecision(undefined), 'refuse');
});

test('host entry names follow OpenSSH conventions for port 22 and custom ports', () => {
  assert.equal(hostEntryName(hostAt(22)), '10.0.0.2');
  assert.equal(hostEntryName(hostAt(2222)), '[10.0.0.2]:2222');
  assert.deepEqual(hostEntryNames(hostAt(2222)), ['[10.0.0.2]:2222', '10.0.0.2']);
  const ipv6: HostConfig = { name: 'v6', ip: '2001:db8::1', user: 'a', port: 22 };
  assert.equal(hostEntryName(ipv6), '2001:db8::1');
  assert.deepEqual(hostEntryNames(ipv6), ['2001:db8::1']);
  assert.equal(hostEntryName({ ...ipv6, port: 2222 }), '[2001:db8::1]:2222');
});

test('keyTypeFromBlob extracts the key type from an OpenSSH blob', () => {
  const blob = Buffer.alloc(4 + 'ssh-ed25519'.length + 8);
  blob.writeUInt32BE('ssh-ed25519'.length, 0);
  blob.write('ssh-ed25519', 4, 'utf8');
  assert.equal(keyTypeFromBlob(blob), 'ssh-ed25519');
  assert.equal(keyTypeFromBlob(Buffer.from('tooshort')), 'unknown');
});

test('appendKnownHostsFile writes standard known_hosts lines idempotently with 0600', async () => {
  const { file } = tempKnownHosts();
  const host = hostAt(2222);
  const keys = [
    { host: hostEntryName(host), type: 'ssh-ed25519', blob: blobA },
    { host: hostEntryName(host), type: 'ssh-rsa', blob: blobB }
  ];
  await appendKnownHostsFile(file, keys);
  await appendKnownHostsFile(file, keys); // 幂等
  const content = await readFile(file, 'utf8');
  assert.equal(content.split(/\r?\n/).filter((line) => line.trim()).length, 2);
  assert.ok(content.includes(lineFor(host, 'ssh-ed25519', blobA)));
  assert.ok(content.includes(lineFor(host, 'ssh-rsa', blobB)));
  assert.equal((statSync(file).mode & 0o777), 0o600);
});

test('readTrustedFingerprints filters entries by host', async () => {
  const { file } = tempKnownHosts();
  const hostA = hostAt(2222);
  const hostB = hostAt(2223);
  await writeFile(file, [
    lineFor(hostA, 'ssh-ed25519', blobA),
    lineFor(hostB, 'ssh-ed25519', blobB),
    '# comment line'
  ].join('\n') + '\n');
  const fpsA = await readTrustedFingerprints(file, hostA);
  assert.equal(fpsA.length, 1);
  assert.ok(fpsA.includes(sha256Fingerprint(Buffer.from(blobA, 'base64'))));
  // 另一个主机不受影响
  assert.deepEqual(
    await readTrustedFingerprints(file, { ...hostA, port: 2224 }), []
  );
});

test('readTrustedFingerprints ignores legacy bracketed IPv6 at the default port', async () => {
  const { file } = tempKnownHosts();
  const host: HostConfig = {
    name: 'v6', ip: '2001:db8::1', user: 'alice', port: 22
  };
  await writeFile(file, `[2001:db8::1] ssh-ed25519 ${blobA}\n`);
  assert.deepEqual(await readTrustedFingerprints(file, host), []);
});

test('replaceKnownHostsForHost removes stale keys but preserves other hosts', async () => {
  const { file } = tempKnownHosts();
  const hostA = hostAt(2222);
  const hostB = hostAt(2223);
  await writeFile(file, [
    '# retained comment',
    lineFor(hostA, 'ssh-ed25519', blobA),
    lineFor(hostA, 'ssh-rsa', blobB),
    lineFor(hostB, 'ssh-ed25519', blobC)
  ].join('\n') + '\n');

  await replaceKnownHostsForHost(file, hostA, [
    { host: 'ignored-scan-name', type: 'ssh-ed25519', blob: blobC }
  ]);

  const content = await readFile(file, 'utf8');
  assert.ok(content.includes('# retained comment'));
  assert.ok(content.includes(lineFor(hostB, 'ssh-ed25519', blobC)));
  assert.ok(content.includes(lineFor(hostA, 'ssh-ed25519', blobC)));
  assert.ok(!content.includes(lineFor(hostA, 'ssh-ed25519', blobA)));
  assert.ok(!content.includes(lineFor(hostA, 'ssh-rsa', blobB)));
  assert.equal((statSync(file).mode & 0o777), 0o600);
});

test('replaceKnownHostsForHost migrates legacy bracketed IPv6 at port 22', async () => {
  const { file } = tempKnownHosts();
  const host: HostConfig = {
    name: 'v6', ip: '2001:db8::1', user: 'alice', port: 22
  };
  await writeFile(file, `[2001:db8::1] ssh-ed25519 ${blobA}\n`);

  await replaceKnownHostsForHost(file, host, [
    { host: host.ip, type: 'ssh-ed25519', blob: blobB }
  ]);

  const content = await readFile(file, 'utf8');
  assert.ok(!content.includes(`[2001:db8::1] ssh-ed25519 ${blobA}`));
  assert.ok(content.includes(`2001:db8::1 ssh-ed25519 ${blobB}`));
});

test('verifyHostKeyWithPrompt passes when the fingerprint is already in the file', async () => {
  const { file } = tempKnownHosts();
  setKnownHostsFilePath(file);
  const host = hostAt(3001);
  await writeFile(file, lineFor(host, 'ssh-ed25519', blobA) + '\n');
  const prompts = {
    firstConnection: async () => { throw new Error('must not prompt'); },
    changed: async () => { throw new Error('must not prompt'); }
  };
  const fps = sha256Fingerprint(Buffer.from(blobA, 'base64'));
  assert.equal(
    await verifyHostKeyWithPrompt(host, [fps], undefined, prompts), 'trusted'
  );
});

test('verifyHostKeyWithPrompt first connection prompts once and allows', async () => {
  const { file } = tempKnownHosts();
  setKnownHostsFilePath(file);
  const host = hostAt(3002);
  let prompts = 0;
  const injected = {
    firstConnection: async () => { prompts += 1; return 'accept' as const; },
    changed: async () => { throw new Error('must not prompt changed'); }
  };
  const fps = sha256Fingerprint(Buffer.from(blobA, 'base64'));
  assert.equal(await verifyHostKeyWithPrompt(host, [fps], undefined, injected), 'accept');
  assert.equal(prompts, 1);
});

test('verifyHostKeyWithPrompt first connection: refuse blocks', async () => {
  const { file } = tempKnownHosts();
  setKnownHostsFilePath(file);
  const host = hostAt(3003);
  const injected = {
    firstConnection: async () => 'refuse' as const,
    changed: async () => { throw new Error('must not prompt changed'); }
  };
  const fps = sha256Fingerprint(Buffer.from(blobA, 'base64'));
  assert.equal(await verifyHostKeyWithPrompt(host, [fps], undefined, injected), 'refuse');
});

test('verifyHostKeyWithPrompt prompts for untrusted keys in a mixed probe batch', async () => {
  const { file } = tempKnownHosts();
  setKnownHostsFilePath(file);
  const host = hostAt(3011);
  await writeFile(file, lineFor(host, 'ssh-ed25519', blobA) + '\n');
  const trusted = sha256Fingerprint(Buffer.from(blobA, 'base64'));
  const untrusted = sha256Fingerprint(Buffer.from(blobB, 'base64'));
  let shownNew: string[] = [];
  const injected = {
    firstConnection: async () => { throw new Error('must prompt changed'); },
    changed: async (_host: HostConfig, _old: string[], next: string[]) => {
      shownNew = next;
      return 'accept' as const;
    }
  };

  assert.equal(
    await verifyHostKeyWithPrompt(host, [trusted, untrusted], undefined, injected),
    'accept'
  );
  assert.deepEqual(shownNew, [untrusted]);
});

test('every new backend key prompts once and is then remembered', async () => {
  const { file } = tempKnownHosts();
  setKnownHostsFilePath(file);
  const host = hostAt(3004);
  let firstPrompts = 0;
  let changedPrompts = 0;
  const injected = {
    firstConnection: async () => { firstPrompts += 1; return 'accept' as const; },
    changed: async () => { changedPrompts += 1; return 'accept' as const; }
  };
  // 首次连接：首次弹窗（确认后由调用方写文件——这里模拟写入）。
  const fpsA = sha256Fingerprint(Buffer.from(blobA, 'base64'));
  assert.equal(await verifyHostKeyWithPrompt(host, [fpsA], undefined, injected), 'accept');
  await appendKnownHostsFile(file, [{ host: hostEntryName(host), type: 'ssh-ed25519', blob: blobA }]);
  // 新后端：变化弹窗（每次新密钥都确认）。
  const fpsB = sha256Fingerprint(Buffer.from(blobB, 'base64'));
  assert.equal(await verifyHostKeyWithPrompt(host, [fpsB], undefined, injected), 'accept');
  await appendKnownHostsFile(file, [{ host: hostEntryName(host), type: 'ssh-ed25519', blob: blobB }]);
  assert.equal(firstPrompts, 1);
  assert.equal(changedPrompts, 1);
  // 已确认过的后端再次出现：文件命中，不弹窗。
  assert.equal(await verifyHostKeyWithPrompt(host, [fpsA], undefined, injected), 'trusted');
  assert.equal(changedPrompts, 1);
  // 另一个新后端：再次弹窗。
  const fpsC = sha256Fingerprint(Buffer.from(blobC, 'base64'));
  assert.equal(await verifyHostKeyWithPrompt(host, [fpsC], undefined, injected), 'accept');
  assert.equal(changedPrompts, 2);
});

test('OpenSSH host-key failure detection excludes ordinary SSH failures', () => {
  assert.equal(isOpenSshHostKeyVerificationFailure(
    'Host key verification failed.'
  ), true);
  assert.equal(isOpenSshHostKeyVerificationFailure(
    'No ED25519 host key is known for [10.0.0.2]:2222 and you have requested strict checking.'
  ), true);
  assert.equal(isOpenSshHostKeyVerificationFailure(
    'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!'
  ), true);
  assert.equal(isOpenSshHostKeyVerificationFailure(
    'Permission denied (publickey,password).'
  ), false);
  assert.equal(isOpenSshHostKeyVerificationFailure(
    'Connection timed out'
  ), false);
});

test('system SSH refreshes trust and retries only host-key failures', async () => {
  let runs = 0;
  let refreshes = 0;
  const result = await runWithOpenSshHostKeyRetry(async () => {
    runs += 1;
    return runs < 3
      ? { exitCode: 255, stdout: '', stderr: 'Host key verification failed.' }
      : { exitCode: 0, stdout: 'ok', stderr: '' };
  }, async () => { refreshes += 1; });
  assert.equal(result.exitCode, 0);
  assert.equal(runs, 3);
  assert.equal(refreshes, 2);

  runs = 0;
  refreshes = 0;
  const authFailure = await runWithOpenSshHostKeyRetry(async () => {
    runs += 1;
    return { exitCode: 255, stdout: '', stderr: 'Permission denied (publickey).' };
  }, async () => { refreshes += 1; });
  assert.equal(authFailure.exitCode, 255);
  assert.equal(runs, 1);
  assert.equal(refreshes, 0);
});

test('system SSH host-key retries are bounded', async () => {
  let runs = 0;
  let refreshes = 0;
  await runWithOpenSshHostKeyRetry(async () => {
    runs += 1;
    return { exitCode: 255, stderr: 'Host key verification failed.' };
  }, async () => { refreshes += 1; }, undefined, 2);
  assert.equal(runs, 3);
  assert.equal(refreshes, 2);
});

test('parseKeyscanOutput extracts unique fingerprints from keyscan lines', () => {
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

test('parseKeyscanLines keeps host/type/blob for known_hosts entries', () => {
  const lines = parseKeyscanLines(
    `# 10.0.0.2:2222 SSH-2.0-OpenSSH_9.6\n[10.0.0.2]:2222 ssh-ed25519 ${blobA}\n`
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].host, '[10.0.0.2]:2222');
  assert.equal(lines[0].type, 'ssh-ed25519');
  assert.equal(lines[0].blob, blobA);
});

test('verifySystemSshHostKey skips verification for accept and reject modes', async () => {
  const probe = async (): Promise<HostKeyProbeResult> => {
    throw new Error('should not be called');
  };
  assert.deepEqual(
    await verifySystemSshHostKey('accept', hostAt(3005), 'linux', undefined, probe),
    { ok: true }
  );
  assert.deepEqual(
    await verifySystemSshHostKey('reject', hostAt(3005), 'linux', undefined, probe),
    { ok: true }
  );
});

test('verifySystemSshHostKey fails closed when probing fails', async () => {
  const probe = async (): Promise<HostKeyProbeResult> => ({
    probed: false, fingerprints: [], error: 'ENOENT'
  });
  const result = await verifySystemSshHostKey('prompt', hostAt(3006), 'linux', undefined, probe);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /无法验证.*SSH 主机密钥/);
});

test('verifySystemSshHostKey passes when a probed fingerprint is already in the file', async () => {
  const { file } = tempKnownHosts();
  const host = hostAt(3007);
  await writeFile(file, lineFor(host, 'ssh-ed25519', blobA) + '\n');
  const probe = async (): Promise<HostKeyProbeResult> => ({
    probed: true,
    fingerprints: [sha256Fingerprint(Buffer.from(blobA, 'base64'))],
    keys: [{ host: hostEntryName(host), type: 'ssh-ed25519', blob: blobA }]
  });
  setKnownHostsFilePath(file);
  const result = await verifySystemSshHostKey('prompt', host, 'linux', undefined, probe);
  assert.deepEqual(result, { ok: true });
});

test('verifySystemSshHostKey first connection: trust stores the key and allows', async () => {
  const { file } = tempKnownHosts();
  const host = hostAt(3008);
  const prompts = {
    firstConnection: async () => 'accept' as const,
    changed: async () => { throw new Error('first connection must not prompt changed'); }
  };
  const probe = async (): Promise<HostKeyProbeResult> => ({
    probed: true,
    fingerprints: [sha256Fingerprint(Buffer.from(blobA, 'base64'))],
    keys: [{ host: hostEntryName(host), type: 'ssh-ed25519', blob: blobA }]
  });
  setKnownHostsFilePath(file);
  const result = await verifySystemSshHostKey('prompt', host, 'linux', undefined, probe, prompts);
  assert.deepEqual(result, { ok: true });
  const content = await readFile(file, 'utf8');
  assert.ok(content.includes(lineFor(host, 'ssh-ed25519', blobA)));
});

test('verifySystemSshHostKey replaces stale keys when the user chooses replacement', async () => {
  const { file } = tempKnownHosts();
  const host = hostAt(3010);
  await writeFile(file, lineFor(host, 'ssh-ed25519', blobA) + '\n');
  const prompts = {
    firstConnection: async () => { throw new Error('must prompt changed'); },
    changed: async () => 'replace' as const
  };
  const probe = async (): Promise<HostKeyProbeResult> => ({
    probed: true,
    fingerprints: [sha256Fingerprint(Buffer.from(blobB, 'base64'))],
    keys: [{ host: hostEntryName(host), type: 'ssh-ed25519', blob: blobB }]
  });
  setKnownHostsFilePath(file);

  assert.deepEqual(
    await verifySystemSshHostKey('prompt', host, 'linux', undefined, probe, prompts),
    { ok: true }
  );
  const content = await readFile(file, 'utf8');
  assert.ok(content.includes(lineFor(host, 'ssh-ed25519', blobB)));
  assert.ok(!content.includes(lineFor(host, 'ssh-ed25519', blobA)));
});

test('verifySystemSshHostKey does not write the file when the key is refused', async () => {
  const { file } = tempKnownHosts();
  const host = hostAt(3009);
  const prompts = {
    firstConnection: async () => 'refuse' as const,
    changed: async () => 'refuse' as const
  };
  const probe = async (): Promise<HostKeyProbeResult> => ({
    probed: true,
    fingerprints: [sha256Fingerprint(Buffer.from(blobA, 'base64'))],
    keys: [{ host: hostEntryName(host), type: 'ssh-ed25519', blob: blobA }]
  });
  setKnownHostsFilePath(file);
  const result = await verifySystemSshHostKey('prompt', host, 'linux', undefined, probe, prompts);
  assert.equal(result.ok, false);
  await assert.rejects(readFile(file, 'utf8'));
});
