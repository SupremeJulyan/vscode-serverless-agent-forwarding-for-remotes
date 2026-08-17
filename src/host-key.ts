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
 * 集合（负载均衡 VIP / 多台服务器共用同一 IP 时，集合中保留所有见过的
 * 后端密钥）。
 *
 * prompt（默认）模式为 TOFU：每主机首次连接确认一次，之后该主机的任何
 * 密钥变化（后端轮换、重装等）静默记录到台账，不再弹窗。首次确认是
 * 唯一一道闸——拦住"一开始就连错机器/被劫持"的情况。
 */

export type HostKeyChangedAction = 'prompt' | 'reject' | 'accept';

/** 用户对首次连接弹窗的决策：信任并连接 / 取消。 */
export type HostKeyDecision = 'accept' | 'refuse';

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

/** 向信任集合追加多个指纹（去重；负载均衡多后端场景保留所有见过的密钥）。 */
export async function appendTrustedHostKeys(
  store: TrustStore, host: HostConfig, fingerprints: string[]
): Promise<void> {
  for (const fingerprint of fingerprints) {
    await addTrustedHostKey(store, host, fingerprint);
  }
}

/** 首次连接弹窗（TOFU：每主机仅此一次确认）。 */
export async function promptFirstConnection(
  host: HostConfig, fingerprint: string
): Promise<HostKeyDecision> {
  const choice = await vscode.window.showWarningMessage(
    `首次连接主机"${host.name}"。\nSSH 主机密钥指纹：${fingerprint}\n是否信任此密钥并继续连接？\n` +
    `（信任后，该主机后续的密钥变化将自动记录，不再重复询问。）`,
    { modal: true }, '信任并连接', '取消'
  );
  return choice === '信任并连接' ? 'accept' : 'refuse';
}

/** 弹窗实现（可注入以便测试）。 */
export interface HostKeyPrompts {
  firstConnection(host: HostConfig, fingerprint: string): Promise<HostKeyDecision>;
}

const defaultPrompts: HostKeyPrompts = {
  firstConnection: promptFirstConnection
};

/** 默认弹窗实现（verifySystemSshHostKey 等可注入覆盖以便测试）。 */
export { defaultPrompts };

/**
 * 主机密钥决策的统一入口（内置 ssh2 通道与系统 ssh 路径共用，TOFU 语义）。
 * 目录/终端的打开顺序为串行（先目录后终端，见 extension.ts），同一时刻
 * 不会有两个校验并发触发，因此这里不做并发去重：
 * 1. 台账已有匹配指纹 → 直接放行；
 * 2. 台账非空（该主机已确认信任过）→ 密钥变化静默记录并放行；
 * 3. 台账为空（首次连接）→ 弹窗确认一次，信任后记录并放行。
 *
 * @returns 是否放行连接。
 */
export async function verifyHostKeyWithPrompt(
  store: TrustStore, host: HostConfig, fingerprints: string[],
  log?: (message: string) => void, prompts: HostKeyPrompts = defaultPrompts
): Promise<boolean> {
  const trusted = trustedHostKeyList(store, host);
  if (fingerprints.some((fingerprint) => trusted.includes(fingerprint))) {
    return true;
  }
  if (trusted.length > 0) {
    // TOFU：该主机已确认信任过，密钥轮换（负载均衡多后端/重装）静默记录。
    await appendTrustedHostKeys(store, host, fingerprints);
    log?.(`主机"${host.name}"已信任，静默记录新密钥：${fingerprints.join(', ')}`);
    return true;
  }
  const decision = prompts.firstConnection(host, fingerprints[0]);
  const choice = await decision;
  if (choice === 'refuse') {
    log?.(`用户拒绝信任主机"${host.name}"，已中止连接`);
    return false;
  }
  await appendTrustedHostKeys(store, host, fingerprints);
  log?.(`首次信任主机"${host.name}"：${fingerprints.join(', ')}`);
  return true;
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
    // prompt（TOFU）：统一入口（与系统 ssh 路径共用）——首次确认一次，
    // 之后该主机的密钥变化静默记录。
    void verifyHostKeyWithPrompt(store, host, [fingerprint], log)
      .then((ok) => callback(ok))
      .catch((error) => {
        // 存储失败放行（信任决策已由用户做出），仅记录警告。
        warnStoreFailure(error);
        callback(true);
      });
  };
}
