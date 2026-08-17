import { createHash } from 'node:crypto';
import { appendFile, chmod, readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { HostVerifier } from 'ssh2';
import { HostConfig } from './config';

/**
 * SSH 主机密钥信任的共享实现，供三条传输路径统一使用：
 * 内置 ssh2 终端（ssh2-terminal.ts）、内置 ssh2 SFTP（sftp/client.ts，
 * 经 extension.ts 注入）、以及系统 ssh（platform.ts 通过
 * StrictHostKeyChecking 设置项映射 + extension.ts 连接前探测校验）。
 *
 * **唯一信任记录是扩展独立的 known_hosts 文件**（~/.safs/known_hosts，
 * 由 extension.ts 激活时通过 setKnownHostsFilePath 注入路径）：
 * 文件里有该主机的密钥指纹 = 已确认（直接放行）；没有 = 弹窗确认
 * （首次连接 / 每次新密钥，MobaXterm 风格），确认后写入文件。
 * 系统 ssh 以 StrictHostKeyChecking=yes + 同一文件做 OpenSSH 原生校验兜底。
 * 与 MobaXterm 同构（隔离文件 + OpenSSH 原生校验），只是确认方式为弹窗。
 */

export type HostKeyChangedAction = 'prompt' | 'reject' | 'accept';

/** 用户对主机密钥弹窗的决策：接受 / 拒绝。 */
export type HostKeyDecision = 'accept' | 'refuse';

let knownHostsFilePath = '';

/** 注入扩展独立 known_hosts 文件路径（extension.ts 激活时调用一次）。 */
export function setKnownHostsFilePath(filePath: string): void {
  knownHostsFilePath = filePath;
}

export function getKnownHostsFilePath(): string {
  return knownHostsFilePath;
}

/** 探测/记录到的服务器主机密钥行（OpenSSH known_hosts 格式：host type blob）。 */
export interface ProbedHostKey {
  /** known_hosts 条目主机字段（`ip` 或 `[ip]:port`，与 ssh 连接参数一致）。 */
  host: string;
  /** 密钥类型（ssh-ed25519 / ssh-rsa / ecdsa-sha2-nistp256 …）。 */
  type: string;
  /** base64 密钥 blob。 */
  blob: string;
}

/** 该主机在 known_hosts 中的规范条目名（写入用）：port 22 → `ip`，否则 `[ip]:port`。 */
export function hostEntryName(host: HostConfig): string {
  const port = host.port ?? 22;
  if (port === 22) {
    return host.ip.includes(':') ? `[${host.ip}]` : host.ip;
  }
  return `[${host.ip}]:${port}`;
}

/** 该主机的候选条目名集合（匹配用：兼容裸 IP / [IP] / [IP]:port 三种写法）。 */
export function hostEntryNames(host: HostConfig): string[] {
  const port = host.port ?? 22;
  const bracketed = `[${host.ip}]`;
  return [host.ip, bracketed, ...(port !== 22 ? [`${bracketed}:${port}`] : [])];
}

/** 从 OpenSSH 密钥 blob 提取类型字符串（blob 前 4 字节为类型名长度）。 */
export function keyTypeFromBlob(blob: Buffer): string {
  try {
    const length = blob.readUInt32BE(0);
    if (length > 0 && length <= blob.length - 4) {
      const type = blob.toString('utf8', 4, 4 + length);
      if (/^[a-z0-9-]+$/i.test(type)) return type;
    }
  } catch {
    // 无法解析的 blob：类型未知。
  }
  return 'unknown';
}

export function sha256Fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

export function hostKeyChangedAction(): HostKeyChangedAction {
  return vscode.workspace.getConfiguration('safs')
    .get<HostKeyChangedAction>('hostKeyChangedAction', 'prompt');
}

/**
 * 把密钥行追加到 known_hosts 文件（幂等：已存在的行跳过）。
 */
export async function appendKnownHostsFile(
  filePath: string, keys: ProbedHostKey[], log?: (message: string) => void
): Promise<void> {
  const lines = keys.map((key) => `${key.host} ${key.type} ${key.blob}`);
  let existing = '';
  try {
    existing = await readFile(filePath, 'utf8');
  } catch {
    // 文件不存在：首次写入。
  }
  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = lines.filter((line) => !existingLines.has(line));
  if (missing.length === 0) return;
  const content = `${existing.endsWith('\n') || existing === '' ? '' : '\n'}${missing.join('\n')}\n`;
  await appendFile(filePath, content, { mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
  log?.(`已写入主机密钥记录（${missing.length} 条）：${filePath}`);
}

/**
 * 读取文件中某主机的已确认密钥指纹集合（按 host 字段过滤）。
 */
export async function readTrustedFingerprints(
  filePath: string, host: HostConfig
): Promise<string[]> {
  const names = new Set(hostEntryNames(host));
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const fingerprints = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(line.trim());
    if (!match || !names.has(match[1])) continue;
    const encoded = match[3];
    // 严格 base64 校验：Node 的宽松解码会忽略非法字符，导致垃圾行被误判为密钥。
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) continue;
    try {
      const blob = Buffer.from(encoded, 'base64');
      if (blob.length > 0) fingerprints.add(sha256Fingerprint(blob));
    } catch {
      // 忽略无法解析的行。
    }
  }
  return [...fingerprints];
}

/** 当前扩展 known_hosts 文件中该主机的已确认指纹（未设置路径时视为空）。 */
export async function trustedFingerprintsFor(host: HostConfig): Promise<string[]> {
  if (!knownHostsFilePath) return [];
  return readTrustedFingerprints(knownHostsFilePath, host);
}

/** 把确认过的密钥写入扩展 known_hosts 文件。 */
export async function recordTrustedHostKey(
  keys: ProbedHostKey[], log?: (message: string) => void
): Promise<void> {
  if (!knownHostsFilePath) return;
  await appendKnownHostsFile(knownHostsFilePath, keys, log);
}

/** 首次连接弹窗文案（目标主机 IP 单独成行突出，便于用户确认连的是否正确的机器）。 */
export function firstConnectionPromptMessage(
  host: HostConfig, fingerprint: string
): string {
  const port = host.port ?? 22;
  const login = host.user ? `（登录用户 ${host.user}）` : '';
  return `首次连接主机"${host.name}"。\n\n` +
    `⚠️ 请确认目标主机：${host.ip}:${port} ${login}\n` +
    `SSH 主机密钥指纹：${fingerprint}\n\n` +
    `是否信任此密钥并继续连接？`;
}

/** 首次连接弹窗（MobaXterm 风格：每主机首次确认）。 */
export async function promptFirstConnection(
  host: HostConfig, fingerprint: string
): Promise<HostKeyDecision> {
  // 只保留一个确认按钮：modal 弹窗自带的 X / Esc 即隐式取消（返回 undefined → 拒绝）。
  const choice = await vscode.window.showWarningMessage(
    firstConnectionPromptMessage(host, fingerprint),
    { modal: true }, '信任并连接'
  );
  return firstConnectionDecision(choice);
}

/** 弹窗选项 → 决策：X / Esc 关闭（undefined）视为拒绝，绝不默认接受。 */
export function firstConnectionDecision(choice: string | undefined): HostKeyDecision {
  return choice === '信任并连接' ? 'accept' : 'refuse';
}

/** 密钥变化弹窗文案（MobaXterm 风格：每次遇到新密钥都确认，两按钮）。 */
export function changedKeyPromptMessage(
  host: HostConfig, oldFingerprints: string[], newFingerprints: string[]
): string {
  const port = host.port ?? 22;
  const login = host.user ? `（登录用户 ${host.user}）` : '';
  // 文件累积后旧指纹可能很多，最多展示 3 个。
  const shownOld = oldFingerprints.length > 3
    ? [...oldFingerprints.slice(0, 3), `…（共 ${oldFingerprints.length} 个）`]
    : oldFingerprints;
  return `主机"${host.name}"的 SSH 主机密钥已改变。\n\n` +
    `⚠️ 目标主机：${host.ip}:${port} ${login}\n` +
    `服务器身份自上次连接后已改变：这可能是服务器主机密钥已更换（重新安装或升级），` +
    `或者你实际上连接到了一台伪装成该服务器的计算机。\n\n` +
    `旧密钥：${shownOld.join('\n')}\n新密钥：${newFingerprints.join('\n')}\n\n` +
    `是否接受新密钥并继续连接？`;
}

/** 密钥变化弹窗（MobaXterm 风格：接受 / 拒绝，无附加密钥选项）。 */
export async function promptHostKeyChanged(
  host: HostConfig, oldFingerprints: string[], newFingerprints: string[]
): Promise<HostKeyDecision> {
  const choice = await vscode.window.showWarningMessage(
    changedKeyPromptMessage(host, oldFingerprints, newFingerprints),
    { modal: true }, '接受新密钥并继续连接', '拒绝新密钥并中止连接'
  );
  return changedKeyDecision(choice);
}

/** 弹窗选项 → 决策：X / Esc 关闭（undefined）视为拒绝，绝不默认接受。 */
export function changedKeyDecision(choice: string | undefined): HostKeyDecision {
  return choice === '接受新密钥并继续连接' ? 'accept' : 'refuse';
}

/** 弹窗实现（可注入以便测试）。 */
export interface HostKeyPrompts {
  firstConnection(host: HostConfig, fingerprint: string): Promise<HostKeyDecision>;
  changed(
    host: HostConfig, oldFingerprints: string[], newFingerprints: string[]
  ): Promise<HostKeyDecision>;
}

const defaultPrompts: HostKeyPrompts = {
  firstConnection: promptFirstConnection,
  changed: promptHostKeyChanged
};

/** 默认弹窗实现（verifySystemSshHostKey 等可注入覆盖以便测试）。 */
export { defaultPrompts };

/**
 * 主机密钥决策的统一入口（内置 ssh2 通道与系统 ssh 路径共用，MobaXterm 风格）。
 * 信任记录 = 扩展 known_hosts 文件（文件里有 = 已确认）：
 * 1. 文件已有匹配指纹 → 直接放行；
 * 2. 文件为空（首次连接）→ 弹窗确认；
 * 3. 文件非空但出现新密钥（后端轮换/重装）→ 弹窗确认。
 * 确认后的写入由调用方完成（hostVerifierFor / verifySystemSshHostKey）。
 *
 * @returns 是否放行连接。
 */
export async function verifyHostKeyWithPrompt(
  host: HostConfig, fingerprints: string[],
  log?: (message: string) => void, prompts: HostKeyPrompts = defaultPrompts
): Promise<boolean> {
  const trusted = await trustedFingerprintsFor(host);
  if (fingerprints.some((fingerprint) => trusted.includes(fingerprint))) {
    return true;
  }
  const decision = trusted.length === 0
    ? prompts.firstConnection(host, fingerprints[0])
    : prompts.changed(host, trusted, fingerprints);
  const choice = await decision;
  if (choice === 'refuse') {
    log?.(`用户拒绝信任主机"${host.name}"的新密钥，已中止连接`);
    return false;
  }
  log?.(`已确认主机"${host.name}"的密钥：${fingerprints.join(', ')}`);
  return true;
}

/**
 * 内置 ssh2 通道（终端 / SFTP）的主机密钥校验器。
 * 信任记录 = 扩展 known_hosts 文件；WSL 中继场景连接的虽是
 * 127.0.0.1:localPort，中继转发的是真实服务器的密钥，条目名用真实目标主机。
 *
 * 记录写入失败时仅记录警告并放行：信任决策本身已由用户交互（或显式
 * accept 设置）做出，记录丢失只会在下次连接时再次提示，方向是更安全而非
 * 更危险；拒绝连接会让存储损坏时完全无法使用。
 *
 * @param log - 可选日志回调（如输出通道），用于记录存储失败等诊断信息。
 */
export function hostVerifierFor(
  host: HostConfig, log?: (message: string) => void
): HostVerifier {
  const warnStoreFailure = (error: unknown) => {
    log?.(`写入主机密钥信任记录失败（${host.name}）：${
      error instanceof Error ? error.message : String(error)
    }`);
  };
  const entry = (key: Buffer): ProbedHostKey => ({
    host: hostEntryName(host),
    type: keyTypeFromBlob(key),
    blob: key.toString('base64')
  });
  return (key, callback) => {
    const fingerprint = sha256Fingerprint(key);
    void (async () => {
      const trusted = await trustedFingerprintsFor(host);
      if (trusted.includes(fingerprint)) {
        callback(true);
        return;
      }
      const action = hostKeyChangedAction();
      if (action === 'reject') {
        void vscode.window.showErrorMessage(
          `主机"${host.name}"的 SSH 主机密钥未受信任，已拒绝连接。`, { modal: true }
        );
        callback(false);
        return;
      }
      if (action === 'accept') {
        try {
          await recordTrustedHostKey([entry(key)]);
        } catch (error) {
          warnStoreFailure(error);
        }
        callback(true);
        return;
      }
      // prompt（MobaXterm 风格）：文件比对 + 弹窗确认，确认后写入文件。
      const allowed = await verifyHostKeyWithPrompt(host, [fingerprint], log);
      if (allowed) {
        try {
          await recordTrustedHostKey([entry(key)]);
        } catch (error) {
          warnStoreFailure(error);
        }
      }
      callback(allowed);
    })();
  };
}
