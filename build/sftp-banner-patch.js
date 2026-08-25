/**
 * 构建期源码补丁：让 ssh2 的 SFTP 版本握手容忍 NSG 网关注入的 MOTD banner。
 *
 * 网关会在 SSH channel 开头注入纯文本 banner，污染 SFTP 子系统通道的首个数据包
 * （4 字节长度字段变成文本/二进制垃圾），ssh2 报 "Packet length … exceeds max
 * length" 后整体失败，插件被迫回退 exec/SCP（网关上每条 exec 秒级，目录加载极慢）。
 *
 * 实际网关的 banner 格式不统一：中文、英文、星号分隔线以及二进制前缀都曾
 * 出现。补丁不识别任何 banner 文案或终止符，而是在版本握手阶段持续缓冲，
 * 逐字节寻找结构合法的 SSH_FXP_VERSION 头：包长至少包含 type+version、包长
 * 不超过 ssh2 上限、type 必须为 VERSION(2)、version 必须是合理的正整数。
 * 找到后只丢弃它之前的字节，后续完全交回 ssh2 原解析器。
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
  '// SAFS-PATCH: gateway preamble probe cap',
  'const SAFS_MOTD_MAX_PROBE = 256 * 1024;'
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
  '      // Find an actual VERSION header, not merely four bytes that resemble',
  '      // a packet length. This makes arbitrary textual/binary preambles safe.',
  '      const maxLen = this._maxInPktLen;',
  '      let found = -1;',
  '      for (let i = 0; i + 9 <= this._motdPending.length; i++) {',
  '        const len = this._motdPending.readUInt32BE(i);',
  '        if (len < 5 || len > maxLen || this._motdPending[i + 4] !== 2) continue;',
  '        const version = this._motdPending.readUInt32BE(i + 5);',
  '        if (version >= 1 && version <= 255) { found = i; break; }',
  '      }',
  '      if (found === -1) {',
  '        if (this._motdPending.length >= SAFS_MOTD_MAX_PROBE) {',
  '          data = this._motdPending;',
  '          this._motdPending = undefined;',
  '          this._motdHandled = true;',
  '        } else {',
  '          return; // wait for more bytes; no format-specific timeout',
  '        }',
  '      } else {',
  '        data = this._motdPending.subarray(found);',
  '        this._motdPending = undefined;',
  '        this._motdHandled = true;',
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
