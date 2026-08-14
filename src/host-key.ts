import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { HostVerifier } from 'ssh2';
import { HostConfig } from './config';

/**
 * SSH 主机密钥信任（TOFU）的共享实现，供三条传输路径统一使用：
 * 内置 ssh2 终端（ssh2-terminal.ts）、内置 ssh2 SFTP（sftp/client.ts，
 * 经 extension.ts 注入）、以及系统 ssh（platform.ts 通过
 * StrictHostKeyChecking 设置项映射，见 hostKeyCheckingOption）。
 */

export type HostKeyChangedAction = 'prompt' | 'reject' | 'accept';

export const trustedHostKeysState = 'safs.trustedSsh2HostKeys';

export function sha256Fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

export function hostKeyChangedAction(): HostKeyChangedAction {
  return vscode.workspace.getConfiguration('safs')
    .get<HostKeyChangedAction>('hostKeyChangedAction', 'accept');
}

export async function storeTrustedHostKey(
  context: vscode.ExtensionContext,
  trusted: Record<string, string>,
  trustKey: string,
  fingerprint: string
): Promise<void> {
  await context.globalState.update(trustedHostKeysState, {
    ...trusted, [trustKey]: fingerprint
  });
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
  const port = host.port ?? 22;
  const trustKey = `${host.ip}:${port}`;
  const warnStoreFailure = (error: unknown) => {
    log?.(`存储主机密钥信任记录失败（${host.name}）：${
      error instanceof Error ? error.message : String(error)
    }`);
  };
  return (key, callback) => {
    const fingerprint = sha256Fingerprint(key);
    const trusted = context.globalState.get<Record<string, string>>(trustedHostKeysState, {});
    if (trusted[trustKey] === fingerprint) {
      callback(true);
      return;
    }
    if (trusted[trustKey]) {
      // MobaXterm 风格：主机密钥改变（常见于负载均衡 VIP 每次连接到不同后端、
      // 各后端密钥不同的场景）时不再直接拒绝，而是按设置提示用户选择。
      const action = hostKeyChangedAction();
      if (action === 'reject') {
        void vscode.window.showErrorMessage(
          `主机"${host.name}"的 SSH 主机密钥已改变，已拒绝连接。`, { modal: true }
        );
        callback(false);
        return;
      }
      if (action === 'accept') {
        void storeTrustedHostKey(context, trusted, trustKey, fingerprint)
          .catch(warnStoreFailure)
          .then(() => callback(true));
        return;
      }
      void vscode.window.showWarningMessage(
        `主机"${host.name}"的 SSH 主机密钥已改变。\n旧密钥：${trusted[trustKey]}\n新密钥：${fingerprint}\n是否接受新密钥并继续连接？`,
        { modal: true }, '接受并连接', '取消'
      ).then(async (choice) => {
        if (choice !== '接受并连接') {
          callback(false);
          return;
        }
        await storeTrustedHostKey(context, trusted, trustKey, fingerprint).catch(warnStoreFailure);
        callback(true);
      });
      return;
    }
    void vscode.window.showWarningMessage(
      `首次连接主机"${host.name}"。是否信任 SSH 主机密钥 ${fingerprint}？`,
      { modal: true }, '信任并连接'
    ).then(async (choice) => {
      if (choice !== '信任并连接') {
        callback(false);
        return;
      }
      await storeTrustedHostKey(context, trusted, trustKey, fingerprint).catch(warnStoreFailure);
      callback(true);
    });
  };
}
