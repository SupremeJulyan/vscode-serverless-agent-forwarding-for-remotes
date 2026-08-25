import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import Module from 'node:module';
// @ts-expect-error 构建脚本（JS），无类型声明
import { patchSftpSource } from '../build/sftp-banner-patch';

/**
 * 在内存中编译打过补丁的 ssh2 SFTP.js（不改动 node_modules），验证
 * NSG 网关 MOTD banner 容忍逻辑：banner 不再导致 "Packet length … exceeds
 * max length"，SFTP 版本握手正常完成。
 */

function compilePatchedSftp(): unknown {
  const origPath = require.resolve('ssh2/lib/protocol/SFTP');
  const src = fs.readFileSync(origPath, 'utf8');
  const patched = patchSftpSource(src);
  const m = new Module(origPath, module);
  m.filename = origPath;
  m.paths = Module._nodeModulePaths(path.dirname(origPath));
  m._compile(patched, origPath);
  return (m.exports as { SFTP: unknown }).SFTP;
}

// SSH_FXP_VERSION (type=2, version=3)
const VERSION_PACKET = Buffer.from([0x00, 0x00, 0x00, 0x05, 0x02, 0x00, 0x00, 0x00, 0x03]);

// 与 scp-session.ts 注释一致的网关 MOTD banner：
//   \r \r 一×17\n |用户类型:包时间用户\n |核数:128\n |到期时间:2029/07/02\n 一×17\r\n
const BANNER = Buffer.concat([
  Buffer.from([0x0d, 0x20, 0x0d, 0x20]),
  Buffer.from(
    '\u4e00'.repeat(17) + '\n|用户类型:包时间用户\n|核数:128\n|到期时间:2029/07/02\n'
  ),
  Buffer.from('\u4e00'.repeat(17) + '\r\n'),
]);

interface SftpLike {
  _version: number;
  push(data: Buffer): void;
  on(event: string, listener: () => void): void;
  _init(): void;
}

function makeSftp(SftpClass: any): SftpLike {
  const fakeProtocol = new Proxy(
    { _remoteIdentRaw: 'SSH-2.0-Test' },
    {
      get(target, key) {
        if (key in target) return (target as Record<string, unknown>)[key];
        return () => undefined;
      }
    }
  );
  const fakeClient = { _protocol: fakeProtocol };
  const chanInfo = {
    type: 'session',
    incoming: { id: 0, window: 2097152, packetSize: 32768, state: 'open' },
    outgoing: { id: 1, window: 2097152, packetSize: 32768, state: 'open' }
  };
  const sftp = new SftpClass(fakeClient, chanInfo, {}) as SftpLike;
  sftp._init();
  return sftp;
}

test('banner + VERSION in one chunk: handshake completes', () => {
  const SftpClass: any = compilePatchedSftp();
  const sftp = makeSftp(SftpClass);
  let ready = false;
  sftp.on('ready', () => {
    ready = true;
  });
  sftp.push(Buffer.concat([BANNER, VERSION_PACKET]));
  assert.equal(sftp._version, 3);
  assert.equal(ready, true);
});

test('banner split byte-by-byte: handshake still completes', () => {
  const SftpClass: any = compilePatchedSftp();
  const sftp = makeSftp(SftpClass);
  let ready = false;
  sftp.on('ready', () => {
    ready = true;
  });
  const payload = Buffer.concat([BANNER, VERSION_PACKET]);
  for (let i = 0; i < payload.length; i++) {
    sftp.push(payload.subarray(i, i + 1));
  }
  assert.equal(sftp._version, 3);
  assert.equal(ready, true);
});

test('banner ends exactly at chunk boundary: waits for VERSION then completes', () => {
  const SftpClass: any = compilePatchedSftp();
  const sftp = makeSftp(SftpClass);
  sftp.push(BANNER);
  assert.equal(sftp._version, -1, 'banner alone must not complete the handshake');
  sftp.push(VERSION_PACKET);
  assert.equal(sftp._version, 3);
});

test('banner preceded by a leading newline: handshake completes', () => {
  const SftpClass: any = compilePatchedSftp();
  const sftp = makeSftp(SftpClass);
  let ready = false;
  sftp.on('ready', () => {
    ready = true;
  });
  // 部分网关在 \r \r banner 前先发一个空行（\n）。
  sftp.push(Buffer.concat([Buffer.from([0x0a]), BANNER, VERSION_PACKET]));
  assert.equal(sftp._version, 3);
  assert.equal(ready, true);
});

test('binary \\n\\0\\0\\0 prefix (observed on yx) is skipped to the VERSION packet', () => {
  const SftpClass: any = compilePatchedSftp();
  const sftp = makeSftp(SftpClass);
  let ready = false;
  sftp.on('ready', () => {
    ready = true;
  });
  // yx 网关实测：SFTP 通道首 4 字节为 0x0A 0x00 0x00 0x00（长度 0x0A000000
  // 非法），后续紧跟真实 VERSION 包。阶段 2 应跳过该前缀直接握手成功。
  sftp.push(Buffer.concat([Buffer.from([0x0a, 0x00, 0x00, 0x00]), VERSION_PACKET]));
  assert.equal(sftp._version, 3);
  assert.equal(ready, true);
});

test('probe bytes are stashed on the client for diagnostics', () => {
  const SftpClass: any = compilePatchedSftp();
  const sftp = makeSftp(SftpClass);
  sftp.push(Buffer.concat([BANNER, VERSION_PACKET]));
  const client = (sftp as unknown as { _client: { _safsMotdProbe?: Buffer } })._client;
  assert.ok(client._safsMotdProbe, 'first-chunk bytes must be stashed');
  assert.ok(client._safsMotdProbe!.length > 0);
});

test('clean VERSION without banner: behaviour unchanged', () => {
  const SftpClass: any = compilePatchedSftp();
  const sftp = makeSftp(SftpClass);
  let ready = false;
  sftp.on('ready', () => {
    ready = true;
  });
  sftp.push(VERSION_PACKET);
  assert.equal(sftp._version, 3);
  assert.equal(ready, true);
});

test('yx English account-information MOTD is skipped instead of treated as fatal', () => {
  const SftpClass: any = compilePatchedSftp();
  const sftp = makeSftp(SftpClass);
  let ready = false;
  sftp.on('ready', () => {
    ready = true;
  });
  const denial = Buffer.from(
    '*'.repeat(90) + '\r\n***your user information can not be found,please contact '
    + 'your customer manager if you need 75***\r\n' + '*'.repeat(90) + '\r\n'
  );
  sftp.push(denial.subarray(0, 25));
  assert.equal(ready, false);
  sftp.push(Buffer.concat([denial.subarray(25), VERSION_PACKET]));
  assert.equal(sftp._version, 3);
  assert.equal(ready, true);
});

test('plausible packet length in binary garbage is ignored unless type is VERSION', () => {
  const SftpClass: any = compilePatchedSftp();
  const sftp = makeSftp(SftpClass);
  let ready = false;
  sftp.on('ready', () => { ready = true; });
  const falseHeader = Buffer.from([0, 0, 0, 5, 0x41, 0, 0, 0, 3]);
  sftp.push(Buffer.concat([falseHeader, Buffer.from('gateway text'), VERSION_PACKET]));
  assert.equal(sftp._version, 3);
  assert.equal(ready, true);
});

test('non-banner garbage without terminator falls through to original behaviour', () => {
  const SftpClass: any = compilePatchedSftp();
  const sftp = makeSftp(SftpClass);
  let fatal: Error | undefined;
  sftp.on('error', (error: Error) => {
    fatal = error;
  });
  // \r \r 开头但没有终止符：探测上限后放行，交给原解析器（报长度错误）。
  const garbage = Buffer.concat([
    Buffer.from([0x0d, 0x20, 0x0d, 0x20]),
    Buffer.alloc(300 * 1024, 0x41)
  ]);
  sftp.push(garbage);
  assert.equal(sftp._version, -1);
  assert.ok(
    fatal && /Packet length/.test(fatal.message),
    'must surface the original packet-length error so the SCP fallback triggers'
  );
});
