/**
 * 构建期源码补丁：让 ssh2 的 SFTP 版本握手容忍 NSG 网关注入的 MOTD banner。
 *
 * 网关会在 SSH channel 开头注入纯文本 banner，污染 SFTP 子系统通道的首个数据包
 * （4 字节长度字段变成文本/二进制垃圾），ssh2 报 "Packet length … exceeds max
 * length" 后整体失败，插件被迫回退 exec/SCP（网关上每条 exec 秒级，目录加载极慢）。
 *
 * 实际网关的 banner 格式不统一：已知有 `\r \r … 一\r\n` 文本 banner，也观测到
 * 以 `\n\0\0\0` 开头的其它结构。因此剥离采用两阶段启发式，仅在版本握手阶段
 * （`_version === -1`）且仅处理首个数据块：
 *
 *  阶段 1（精确）：在缓冲区内任意位置找 `\r \r` 签名（允许前导空行/空白），
 *   再从签名处找 `一\r\n` 终止符，剥离到终止符后开始解析（banner 可跨 chunk）。
 *  阶段 2（通用）：无 `\r \r` 签名时，逐字节扫描首个"合法 SFTP 包长度"
 *   （1 ≤ len ≤ 262144）位置并跳过此前缀。ASCII/UTF-8 文本的长度字段必然
 *   超过 262144（首个字节 ≥ 0x20），不可能误判；即便误判，类型校验失败仍会
 *   走原有报错 → SCP 回退，不会卡死。
 *
 * 安全边界：仅在握手阶段、只丢弃服务端发来的字节、探测上限 256KB（内存有界）、
 * 握手完成后零开销且正常服务器行为完全不变（单测覆盖）。另把通道首 128 字节
 * 暂存到 `client._safsMotdProbe`，握手失败时由 client.ts 记录 hex 以便诊断。
 *
 * 通过 esbuild onLoad 插件在打包时注入（见 esbuild.js），产物为自包含单文件，
 * 无运行时依赖；锚点缺失时抛错让构建失败，避免静默打包出未打补丁的版本。
 */

const ANCHOR_CONST = 'const bufferParser = makeBufferParser();';
const ANCHOR_CTOR = [
  '    this._pktLenBytes = 0;',
  '    this._pktLen = 0;',
  '    this._pktPos = 0;',
  '    this._pktType = 0;'
].join('\n');
const ANCHOR_PUSH = '    let p = 0;\n\n    while (p < data.length) {';

const INJECT_CONST = [
  '// SAFS-PATCH: NSG gateway MOTD banner signatures and probe cap',
  'const SAFS_MOTD_SIG = Buffer.from([0x0d, 0x20, 0x0d, 0x20]); // \\r \\r',
  'const SAFS_MOTD_TERMINATOR = Buffer.from([0xe4, 0xb8, 0x80, 0x0d, 0x0a]); // 一 + CRLF',
  'const SAFS_MOTD_MAX_PROBE = 256 * 1024;',
  "const SAFS_ACCOUNT_DENIED = Buffer.from('your user information can not be found');"
].join('\n');

const INJECT_CTOR = [
  '    // SAFS-PATCH: banner-tolerant SFTP version handshake state',
  '    this._motdPending = undefined;',
  '    this._motdHandled = undefined;'
].join('\n');

const INJECT_PUSH = [
  '    // SAFS-PATCH: tolerate a gateway MOTD banner prefix during the SFTP',
  '    // version handshake (the banner would corrupt the first packet).',
  '    // 仅处理首个数据块：一旦确认无 banner 或已剥离（_motdHandled），后续数据',
  '    // 直接交给解析器（其自带跨 chunk 的半包状态），避免包尾小块被缓冲饿死。',
  '    if (this._version === -1 && this._motdHandled === undefined) {',
  '      if (this._motdPending === undefined) {',
  '        this._motdPending = Buffer.alloc(0);',
  '        try { this._client._safsMotdProbe = data.subarray(0, 128); } catch {}',
  '      }',
  '      this._motdPending = Buffer.concat([this._motdPending, data]);',
  '      if (this._motdPending.toString(\'utf8\').toLowerCase().includes(',
  "          SAFS_ACCOUNT_DENIED.toString('utf8'))) {",
  "        const err = new Error('远程网关未找到该用户信息，请联系客户经理或管理员开通账号');",
  "        err.code = 'SAFS_ACCOUNT_NOT_FOUND';",
  "        err.level = 'sftp-protocol';",
  "        this.emit('error', err);",
  '        this.destroy();',
  '        return;',
  '      }',
  '      if (this._motdPending.length < 8) return;',
  '      const sigIdx = this._motdPending.indexOf(SAFS_MOTD_SIG);',
  '      if (sigIdx !== -1) {',
  '        const termIdx = this._motdPending.indexOf(SAFS_MOTD_TERMINATOR, sigIdx);',
  '        if (termIdx !== -1) {',
  '          data = this._motdPending.subarray(termIdx + SAFS_MOTD_TERMINATOR.length);',
  '          this._motdPending = undefined;',
  '          this._motdHandled = true;',
  '          if (data.length === 0) return;',
  '        } else {',
  '          if (this._motdPending.length >= SAFS_MOTD_MAX_PROBE) {',
  '            data = this._motdPending;',
  '            this._motdPending = undefined;',
  '            this._motdHandled = true;',
  '          } else {',
  '            return; // still inside banner, keep buffering',
  '          }',
  '        }',
  '      } else {',
  '        // No known MOTD signature: skip to the first plausible packet',
  '        // boundary (text banner bytes can never form a valid length).',
  '        const maxLen = this._maxInPktLen;',
  '        let found = -1;',
  '        for (let i = 0; i + 4 <= this._motdPending.length; i++) {',
  '          const len = this._motdPending.readUInt32BE(i);',
  '          if (len >= 1 && len <= maxLen) { found = i; break; }',
  '        }',
  '        if (found === -1) {',
  '          if (this._motdPending.length >= SAFS_MOTD_MAX_PROBE) {',
  '            data = this._motdPending;',
  '            this._motdPending = undefined;',
  '            this._motdHandled = true;',
  '          } else {',
  '            return; // not enough data to find a boundary yet',
  '          }',
  '        } else {',
  '          data = this._motdPending.subarray(found);',
  '          this._motdPending = undefined;',
  '          this._motdHandled = true;',
  '          if (data.length === 0) return;',
  '        }',
  '      }',
  '    }'
].join('\n');

function patchSftpSource(contents) {
  const apply = (source, anchor, injection, label) => {
    const idx = source.indexOf(anchor);
    if (idx === -1) {
      throw new Error(`[sftp-banner-patch] anchor not found: ${label}`);
    }
    return (
      source.slice(0, idx + anchor.length)
      + '\n' + injection
      + source.slice(idx + anchor.length)
    );
  };
  let out = contents;
  out = apply(out, ANCHOR_CONST, INJECT_CONST, 'module consts');
  out = apply(out, ANCHOR_CTOR, INJECT_CTOR, 'constructor state');
  out = apply(out, ANCHOR_PUSH, INJECT_PUSH, 'push() handshake');
  return out;
}

module.exports = { patchSftpSource };
