import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { HostVerifier } from 'ssh2';
import { HostConfig } from './config';

/**
 * SSH 主机密钥信任（TOFU）的共享实现，供三条传输路径统一使用：
 * 内置 ssh2 终端（ssh2-terminal.ts）、内置 ssh2 SFTP（sftp/client.ts，
 * 经 extension.ts 注入）、以及系统 ssh（platform.ts 通过
 * StrictHostKeyChecking 设置项映射 + extension.ts 连接前探测校验）。
 *
 * 信任台账（globalState，key 为 ip:port）保存的是该主机的受信任密钥指纹
 * 集合：负载均衡 VIP / 多台服务器共用同一 IP 时，MobaXterm 风格支持把新
 * 密钥“保存为附加密钥（保留现有）”，集合中同时保留多个后端的密钥。
 */

export type HostKeyChangedAction = 'prompt' | 'reject' | 'accept';

/** 用户对主机密钥弹窗的决策：接受（替换）/ 拒绝 / 接受并保存为附加密钥。 */
export type HostKeyDecision = 'accept' | 'refuse' | 'add';

export const trustedHostKeysState = 'safs.trustedSsh2HostKeys';

/** 最小信任存储接口（vscode.ExtensionContext.globalState 满足该结构）。 */
export interface TrustStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export function sha256Fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

export function hostKeyChangedAction(): HostKeyChangedAction {
  return vscode.workspace.getConfiguration('safs')
    .get<HostKeyChangedAction>('hostKeyChangedAction', 'prompt');
}

export function trustKeyFor(host: HostConfig): string {
  return `${host.ip}:${host.port ?? 22}`;
}

/**
 * 读取某主机的受信任密钥指纹集合。兼容旧版单指纹字符串存储（迁移为数组）。
 */
export function trustedHostKeyList(store: TrustStore, host: HostConfig): string[] {
  const stored = store.get<Record<string, string | string[]>>(trustedHostKeysState, {});
  const value = stored[trustKeyFor(host)];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  return [];
}

async function writeTrustedHostKeyList(
  store: TrustStore, host: HostConfig, fingerprints: string[]
): Promise<void> {
  const stored = store.get<Record<string, string | string[]>>(trustedHostKeysState, {});
  await store.update(trustedHostKeysState, {
    ...stored, [trustKeyFor(host)]: fingerprints
  });
}

/** 向信任集合追加一个指纹（已存在则跳过）。 */
export async function addTrustedHostKey(
  store: TrustStore, host: HostConfig, fingerprint: string
): Promise<void> {
  const current = trustedHostKeyList(store, host);
  if (current.includes(fingerprint)) return;
  await writeTrustedHostKeyList(store, host, [...current, fingerprint]);
}

/** 用当前密钥集整体替换信任集合（MobaXterm “接受新密钥并继续连接”语义）。 */
export async function replaceTrustedHostKeys(
  store: TrustStore, host: HostConfig, fingerprints: string[]
): Promise<void> {
  await writeTrustedHostKeyList(store, host, fingerprints);
}

/** 首次连接弹窗（MobaXterm 风格）。 */
export async function promptFirstConnection(
  host: HostConfig, fingerprint: string
): Promise<HostKeyDecision> {
  const choice = await vscode.window.showWarningMessage(
    `首次连接主机"${host.name}"。\nSSH 主机密钥指纹：${fingerprint}\n是否信任此密钥并继续连接？`,
    { modal: true }, '信任并连接', '取消'
  );
  return choice === '信任并连接' ? 'accept' : 'refuse';
}

/** 主机密钥变化弹窗：三选一，文案参考 MobaXterm 官方对话框。 */
export async function promptHostKeyChanged(
  host: HostConfig, oldFingerprints: string[], newFingerprints: string[]
): Promise<HostKeyDecision> {
  // 附加密钥累积后旧指纹可能很多，最多展示 3 个。
  const shownOld = oldFingerprints.length > 3
    ? [...oldFingerprints.slice(0, 3), `…（共 ${oldFingerprints.length} 个）`]
    : oldFingerprints;
  const choice = await vscode.window.showWarningMessage(
    `主机"${host.name}"的 SSH 主机密钥已改变。\n\n` +
    `服务器身份自上次连接后已改变：这可能是服务器主机密钥已更换（重新安装或升级），` +
    `或者你实际上连接到了一台伪装成该服务器的计算机。\n\n` +
    `旧密钥：${shownOld.join('\n')}\n新密钥：${newFingerprints.join('\n')}\n\n` +
    `（若多台服务器共用此 IP 或为负载均衡 VIP，可选择"保存为附加密钥"保留旧密钥；` +
    `本会话内将不再对该主机重复提示。）`,
    { modal: true },
    '接受新密钥并继续连接', '拒绝新密钥并中止连接', '接受并保存为附加密钥（保留现有）'
  );
  switch (choice) {
    case '接受并保存为附加密钥（保留现有）': return 'add';
    case '拒绝新密钥并中止连接': return 'refuse';
    default: return 'accept';
  }
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

/** 同主机尚未完成的决策（去重：并发触发时只弹一次窗）。 */
const pendingHostKeyDecisions = new Map<string, Promise<HostKeyDecision>>();

/**
 * 本会话内用户已明确信任过的主机（首次连接信任 / 接受新密钥 / 保存为附加密钥）。
 * 这些主机的密钥轮换（负载均衡 VIP 多后端）在本次 VS Code 会话内静默记录，
 * 不再重复弹窗；新会话重新校验，保持跨会话安全姿态。
 */
const sessionAcknowledgedHosts = new Set<string>();

/**
 * 主机密钥决策的统一入口（内置 ssh2 通道与系统 ssh 路径共用）：
 * 1. 台账已有匹配指纹 → 直接放行；
 * 2. 本会话已明确信任过该主机 → 静默记录新指纹并放行；
 * 3. 同主机已有弹窗在等待 → 等其完成后重新核对（不再重复弹窗）；
 * 4. 否则弹窗（首次连接 / 密钥变化三选），并按决策更新台账。
 *
 * @returns 是否放行连接。
 */
export async function verifyHostKeyWithPrompt(
  store: TrustStore, host: HostConfig, fingerprints: string[],
  log?: (message: string) => void, prompts: HostKeyPrompts = defaultPrompts
): Promise<boolean> {
  const key = trustKeyFor(host);
  const trusted = trustedHostKeyList(store, host);
  if (fingerprints.some((fingerprint) => trusted.includes(fingerprint))) {
    return true;
  }
  if (sessionAcknowledgedHosts.has(key)) {
    for (const fingerprint of fingerprints) {
      await addTrustedHostKey(store, host, fingerprint);
    }
    log?.(`本会话已信任该主机，静默记录新密钥：${fingerprints.join(', ')}`);
    return true;
  }
  const pending = pendingHostKeyDecisions.get(key);
  if (pending) {
    // 同主机已有弹窗在等待（如 SFTP 与终端同时触发）：等其完成后重新核对台账。
    const choice = await pending;
    if (choice === 'refuse') return false;
    return verifyHostKeyWithPrompt(store, host, fingerprints, log, prompts);
  }
  const first = trusted.length === 0;
  const decision = first
    ? prompts.firstConnection(host, fingerprints[0])
    : prompts.changed(host, trusted, fingerprints);
  pendingHostKeyDecisions.set(key, decision);
  try {
    const choice = await decision;
    if (choice === 'refuse') return false;
    // 用户已明确决策：本会话内不再对该主机重复弹窗（密钥轮换静默记录）。
    sessionAcknowledgedHosts.add(key);
    const allowed = await applyHostKeyDecision(store, host, choice, fingerprints);
    if (!allowed) {
      log?.(`用户拒绝接受主机"${host.name}"的主机密钥`);
    }
    return allowed;
  } finally {
    if (pendingHostKeyDecisions.get(key) === decision) {
      pendingHostKeyDecisions.delete(key);
    }
  }
}

/** 按用户决策更新信任台账；返回是否放行连接。 */
export async function applyHostKeyDecision(
  store: TrustStore, host: HostConfig,
  decision: HostKeyDecision, fingerprints: string[]
): Promise<boolean> {
  switch (decision) {
    case 'refuse':
      return false;
    case 'add':
      for (const fingerprint of fingerprints) {
        await addTrustedHostKey(store, host, fingerprint);
      }
      return true;
    default:
      await replaceTrustedHostKeys(store, host, fingerprints);
      return true;
  }
}

/**
 * 内置 ssh2 通道（终端 / SFTP）的主机密钥校验器。
 * 信任记录存 globalState（key 为 ip:port，指向真实目标主机，WSL 中继场景
 * 连接的虽是 127.0.0.1:localPort，中继转发的是真实服务器的密钥）。
 *
 * 信任记录写入失败时仅记录警告并放行：信任决策本身已由用户交互（或显式
 * accept 设置）做出，记录丢失只会在下次连接时再次提示，方向是更安全而非
 * 更危险；拒绝连接会让存储损坏时完全无法使用。
 *
 * @param log - 可选日志回调（如输出通道），用于记录存储失败等诊断信息。
 */
export function hostVerifierFor(
  context: vscode.ExtensionContext, host: HostConfig, log?: (message: string) => void
): HostVerifier {
  const warnStoreFailure = (error: unknown) => {
    log?.(`存储主机密钥信任记录失败（${host.name}）：${
      error instanceof Error ? error.message : String(error)
    }`);
  };
  return (key, callback) => {
    const fingerprint = sha256Fingerprint(key);
    const trusted = trustedHostKeyList(context.globalState, host);
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
    const store = context.globalState;
    if (action === 'accept') {
      void addTrustedHostKey(store, host, fingerprint)
        .catch(warnStoreFailure)
        .then(() => callback(true));
      return;
    }
    // prompt：统一入口（与系统 ssh 路径共用）——并发去重、会话内不重复弹窗。
    void verifyHostKeyWithPrompt(store, host, [fingerprint], log)
      .then((ok) => callback(ok))
      .catch((error) => {
        // 存储失败放行（信任决策已由用户做出），仅记录警告。
        warnStoreFailure(error);
        callback(true);
      });
  };
}
