import { createHash, randomBytes } from 'node:crypto';
import {
  chmod, mkdir, readFile, rename, rmdir, stat, unlink, writeFile
} from 'node:fs/promises';
import * as path from 'node:path';
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
 * （首次连接 / 每次新密钥），确认后写入文件。
 * 系统 ssh 以 StrictHostKeyChecking=yes + 同一文件做 OpenSSH 原生校验兜底。
 */

export type HostKeyChangedAction = 'prompt' | 'reject' | 'accept';

/** 用户对主机密钥弹窗的决策：追加、替换或拒绝。 */
export type HostKeyDecision = 'accept' | 'replace' | 'refuse';
export type HostKeyTrustResult = 'trusted' | HostKeyDecision;

let knownHostsFilePath = '';

const knownHostsLockTimeoutMs = 5_000;
const knownHostsStaleLockMs = 120_000;

function isFileError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

async function readKnownHostsOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return '';
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isFileError(error, 'EPERM');
  }
}

async function removeStaleKnownHostsLock(lockPath: string): Promise<boolean> {
  const ownerPath = path.join(lockPath, 'owner.json');
  try {
    const lockStat = await stat(lockPath);
    let owner: { pid?: unknown } = {};
    let hasOwner = false;
    try {
      owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid?: unknown };
      hasOwner = true;
    } catch {
      // 损坏或缺失的 owner 记录只能按目录年龄判断。
    }
    if (typeof owner.pid === 'number' && processIsAlive(owner.pid)) return false;
    if (!hasOwner && Date.now() - lockStat.mtimeMs < knownHostsStaleLockMs) return false;
    await unlink(ownerPath).catch((error) => {
      if (!isFileError(error, 'ENOENT')) throw error;
    });
    await rmdir(lockPath);
    return true;
  } catch (error) {
    if (isFileError(error, 'ENOENT') || isFileError(error, 'ENOTEMPTY')) return false;
    throw error;
  }
}

async function withKnownHostsLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const parent = path.dirname(filePath);
  const lockPath = `${filePath}.lock`;
  const ownerPath = path.join(lockPath, 'owner.json');
  const token = randomBytes(16).toString('hex');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + knownHostsLockTimeoutMs;
  while (true) {
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
      await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }), {
        encoding: 'utf8', mode: 0o600, flag: 'wx'
      });
      break;
    } catch (error) {
      if (created) {
        await unlink(ownerPath).catch(() => undefined);
        await rmdir(lockPath).catch(() => undefined);
      }
      if (!isFileError(error, 'EEXIST')) throw error;
      if (await removeStaleKnownHostsLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`等待主机密钥文件锁超时：${filePath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
    }
  }
  try {
    return await action();
  } finally {
    try {
      const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { token?: unknown };
      if (owner.token === token) {
        await unlink(ownerPath);
        await rmdir(lockPath);
      }
    } catch (error) {
      if (!isFileError(error, 'ENOENT')) throw error;
    }
  }
}

async function writeKnownHostsAtomically(filePath: string, content: string): Promise<void> {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  );
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, filePath);
    await chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await unlink(temporary).catch((error) => {
      if (!isFileError(error, 'ENOENT')) throw error;
    });
  }
}

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
  if (port === 22) return host.ip;
  return `[${host.ip}]:${port}`;
}

/** OpenSSH 对该连接实际会匹配的条目名。非标准端口也会回退检查裸主机名。 */
export function hostEntryNames(host: HostConfig): string[] {
  const port = host.port ?? 22;
  return port === 22 ? [host.ip] : [`[${host.ip}]:${port}`, host.ip];
}

/** 替换时额外清理旧版本写入、但 OpenSSH 不会匹配的方括号格式。 */
function removableHostEntryNames(host: HostConfig): string[] {
  const port = host.port ?? 22;
  return [...new Set([
    ...hostEntryNames(host), `[${host.ip}]`, `[${host.ip}]:${port}`
  ])];
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
  let added = 0;
  await withKnownHostsLock(filePath, async () => {
    const existing = await readKnownHostsOrEmpty(filePath);
    const existingLines = new Set(
      existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    );
    const missing = lines.filter((line) => !existingLines.has(line));
    added = missing.length;
    if (added === 0) return;
    const separator = existing.endsWith('\n') || existing === '' ? '' : '\n';
    await writeKnownHostsAtomically(
      filePath, `${existing}${separator}${missing.join('\n')}\n`
    );
  });
  if (added > 0) log?.(`已写入主机密钥记录（${added} 条）：${filePath}`);
}

/**
 * 移除该主机已有的普通 known_hosts 条目，并写入当前探测到的密钥。
 * 注释、空行及其他主机条目保持不变。
 */
export async function replaceKnownHostsForHost(
  filePath: string, host: HostConfig, keys: ProbedHostKey[],
  log?: (message: string) => void
): Promise<void> {
  const names = new Set(removableHostEntryNames(host));
  const entry = hostEntryName(host);
  const replacements = [...new Set(
    keys.map((key) => `${entry} ${key.type} ${key.blob}`)
  )];
  await withKnownHostsLock(filePath, async () => {
    const existing = await readKnownHostsOrEmpty(filePath);
    const kept = existing.split(/\r?\n/).filter((line) => {
      const match = /^(\S+)\s+/.exec(line.trim());
      return !match || !names.has(match[1]);
    });
    while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
    await writeKnownHostsAtomically(
      filePath, [...kept, ...replacements].join('\n') + '\n'
    );
  });
  log?.(`已替换主机密钥记录（${replacements.length} 条）：${filePath}`);
}

/**
 * 读取文件中某主机的已确认密钥指纹集合（按 host 字段过滤）。
 */
export async function readTrustedFingerprints(
  filePath: string, host: HostConfig
): Promise<string[]> {
  const names = new Set(hostEntryNames(host));
  const content = await readKnownHostsOrEmpty(filePath);
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

/** 用当前密钥替换扩展 known_hosts 中该主机的所有旧条目。 */
export async function replaceTrustedHostKeys(
  host: HostConfig, keys: ProbedHostKey[], log?: (message: string) => void
): Promise<void> {
  if (!knownHostsFilePath) return;
  await replaceKnownHostsForHost(knownHostsFilePath, host, keys, log);
}

/** 首次连接弹窗文案（目标主机 IP 单独成行突出，便于用户确认连的是否正确的机器）。 */
export function firstConnectionPromptMessage(
  host: HostConfig, fingerprints: string[]
): string {
  const port = host.port ?? 22;
  const login = host.user ? `（登录用户 ${host.user}）` : '';
  return `首次连接主机"${host.name}"。\n\n` +
    `⚠️ 请确认目标主机：${host.ip}:${port} ${login}\n` +
    `SSH 主机密钥指纹：\n${fingerprints.join('\n')}\n\n` +
    `是否信任这些密钥并继续连接？`;
}

/** 首次连接弹窗（每主机首次确认）。 */
export async function promptFirstConnection(
  host: HostConfig, fingerprints: string[]
): Promise<HostKeyDecision> {
  // 只保留一个确认按钮：modal 弹窗自带的 X / Esc 即隐式取消（返回 undefined → 拒绝）。
  const choice = await vscode.window.showWarningMessage(
    firstConnectionPromptMessage(host, fingerprints),
    { modal: true }, '信任并连接'
  );
  return firstConnectionDecision(choice);
}

/** 弹窗选项 → 决策：X / Esc 关闭（undefined）视为拒绝，绝不默认接受。 */
export function firstConnectionDecision(choice: string | undefined): HostKeyDecision {
  return choice === '信任并连接' ? 'accept' : 'refuse';
}

/** 密钥变化弹窗文案（每次遇到新密钥都确认）。 */
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
    `服务器身份自上次连接后已改变：这可能是服务器主机密钥已更换，` +
    `或者你实际上连接到了一台伪装成该服务器的计算机。\n\n` +
    `旧密钥：${shownOld.join('\n')}\n新密钥：${newFingerprints.join('\n')}\n\n` +
    `请选择替换旧密钥（SSH主机重装）/ 追加新密钥（SSH主机为负载节点） / 拒绝（不信任该主机）。`;
}

/** 密钥变化弹窗：明确选择替换或追加，X / Esc 即拒绝。 */
export async function promptHostKeyChanged(
  host: HostConfig, oldFingerprints: string[], newFingerprints: string[]
): Promise<HostKeyDecision> {
  const choice = await vscode.window.showWarningMessage(
    changedKeyPromptMessage(host, oldFingerprints, newFingerprints),
    { modal: true }, '替换旧密钥', '追加新密钥', '拒绝'
  );
  return changedKeyDecision(choice);
}

/** 弹窗选项 → 决策：X / Esc 关闭（undefined）视为拒绝，绝不默认接受。 */
export function changedKeyDecision(choice: string | undefined): HostKeyDecision {
  if (choice === '替换旧密钥') return 'replace';
  if (choice === '追加新密钥') return 'accept';
  return 'refuse';
}

/** 弹窗实现（可注入以便测试）。 */
export interface HostKeyPrompts {
  firstConnection(host: HostConfig, fingerprints: string[]): Promise<HostKeyDecision>;
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
 * 主机密钥决策的统一入口（内置 ssh2 通道与系统 ssh 路径共用）。
 * 信任记录 = 扩展 known_hosts 文件（文件里有 = 已确认）：
 * 1. 文件已有匹配指纹 → 直接放行；
 * 2. 文件为空（首次连接）→ 弹窗确认；
 * 3. 文件非空但出现新密钥（后端轮换/重装）→ 弹窗确认。
 * 确认后的写入由调用方完成（hostVerifierFor / verifySystemSshHostKey）。
 *
 * @returns 已信任、追加、替换或拒绝；调用方据此更新信任库。
 */
export async function verifyHostKeyWithPrompt(
  host: HostConfig, fingerprints: string[],
  log?: (message: string) => void, prompts: HostKeyPrompts = defaultPrompts
): Promise<HostKeyTrustResult> {
  const trusted = await trustedFingerprintsFor(host);
  const untrusted = [...new Set(fingerprints)].filter(
    (fingerprint) => !trusted.includes(fingerprint)
  );
  if (untrusted.length === 0) {
    return 'trusted';
  }
  const decision = trusted.length === 0
    ? prompts.firstConnection(host, untrusted)
    : prompts.changed(host, trusted, untrusted);
  const choice = await decision;
  if (choice === 'refuse') {
    log?.(`用户拒绝信任主机"${host.name}"的新密钥，已中止连接`);
    return 'refuse';
  }
  log?.(`已确认主机"${host.name}"的密钥：${untrusted.join(', ')}`);
  return choice;
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
      // prompt：文件比对 + 弹窗确认，确认后写入文件。
      const decision = await verifyHostKeyWithPrompt(host, [fingerprint], log);
      const allowed = decision !== 'refuse';
      if (decision === 'accept') {
        try {
          await recordTrustedHostKey([entry(key)]);
        } catch (error) {
          warnStoreFailure(error);
        }
      } else if (decision === 'replace') {
        try {
          await replaceTrustedHostKeys(host, [entry(key)]);
        } catch (error) {
          warnStoreFailure(error);
        }
      }
      callback(allowed);
    })();
  };
}
