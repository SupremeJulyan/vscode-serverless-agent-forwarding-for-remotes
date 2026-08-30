import * as os from 'node:os';
import { HostConfig } from './config';
import { hostEntryName } from './host-key';
import { shellQuote } from './shell-quote';
import { kexAlgorithmsArgs, legacySshAlgorithmArgs } from './ssh-algorithms';
import { sshBridgePath } from './wsl-bridge';

export type PlatformKind = 'windows' | 'macos' | 'linux' | 'wsl';

export function platformExtensionStateKey(name: string, platform: PlatformKind): string {
  return `safs.${name}.${platform}`;
}

export interface CommandPlan {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

export interface ConnectionOptions {
  reuseSshConnection?: boolean;
  bridgeMasterPassword?: string;
  bridgeConfigPath?: string;
  /** safs.hostKeyChangedAction 设置值：accept→no、prompt/reject→yes */
  hostKeyPolicy?: 'accept' | 'prompt' | 'reject';
  /**
   * 扩展独立的 known_hosts 文件路径（prompt 模式注入）：
   * 扩展已确认的密钥写入该文件，系统 ssh 以 StrictHostKeyChecking=yes
   * 对该文件做 OpenSSH 原生校验兜底（见 system-ssh-host-key.ts）。
   */
  userKnownHostsFile?: string;
}

/**
 * 系统 ssh 路径的主机密钥参数（与 safs.hostKeyChangedAction 设置一致）：
 * - accept → StrictHostKeyChecking=no + known_hosts 指向空设备（完全静默，
 *   每次连接都视为新主机，永不进入密钥变化分支）；
 * - prompt → StrictHostKeyChecking=yes + 扩展独立 known_hosts 文件
 *   （校验由扩展弹窗完成，OpenSSH 原生校验兜底）；
 * - reject → StrictHostKeyChecking=yes + 用户真实 known_hosts（严格校验）。
 *
 * 说明：仅 StrictHostKeyChecking=no 不够 —— OpenSSH 对“已知主机密钥变化”
 * 即使放行（continue_unsafe 分支）也会禁用密码/键盘交互认证，密码登录的
 * 第二次连接会报 Permission denied；accept 模式因此把 known_hosts 指向
 * 空设备（/dev/null，Windows 为 NUL）并 LogLevel=ERROR 消除
 * “Permanently added …” 噪音（真实错误仍正常显示）。
 */
/** WSL 桥的 WSL_VPN_STRICT_HOST_KEY 值：prompt/reject → yes（原生校验），accept → no。 */
function hostKeyStrictValue(policy?: string): string {
  return policy === 'accept' ? 'no' : 'yes';
}

function hostKeyArgs(kind: PlatformKind, options?: ConnectionOptions): string[] {
  const policy = options?.hostKeyPolicy;
  if (policy === 'accept') {
    const device = kind === 'windows' ? 'NUL' : '/dev/null';
    return [
      '-o', 'StrictHostKeyChecking=no',
      '-o', `UserKnownHostsFile=${device}`,
      '-o', `GlobalKnownHostsFile=${device}`,
      '-o', 'LogLevel=ERROR'
    ];
  }
  // prompt / reject：StrictHostKeyChecking=yes 原生校验。
  const args = ['-o', 'StrictHostKeyChecking=yes'];
  if (policy === 'prompt' && options?.userKnownHostsFile) {
    // 扩展独立 known_hosts（不影响用户真实文件）；GlobalKnownHostsFile
    // 指向空设备，避免系统级 /etc/ssh/ssh_known_hosts 干扰。
    const nullDevice = kind === 'windows' ? 'NUL' : '/dev/null';
    args.push(
      '-o', `UserKnownHostsFile=${options.userKnownHostsFile}`,
      '-o', `GlobalKnownHostsFile=${nullDevice}`
    );
  }
  return args;
}

export interface PlatformAdapter {
  readonly kind: PlatformKind;
  terminal(host: HostConfig, remoteCwd?: string, options?: ConnectionOptions): CommandPlan;
  exec(host: HostConfig, remoteCwd: string, command: string, options?: ConnectionOptions): CommandPlan;
}

function connectionReuseArgs(options?: ConnectionOptions): string[] {
  // 缺省复用（与 WslAdapter 的 `=== false ? '0' : '1'` 语义一致），
  // 显式 false 才关闭。
  return options?.reuseSshConnection === false
    ? []
    : [
        '-o', 'ControlMaster=auto',
        '-o', 'ControlPersist=10m',
        '-o', 'ControlPath=~/.ssh/safs-%C'
      ];
}

function sshArgs(
  kind: PlatformKind, host: HostConfig, remoteCwd?: string, options?: ConnectionOptions
): string[] {
  // 主机密钥策略由 safs.hostKeyChangedAction 设置驱动（accept→no+空设备、
  // prompt→yes+扩展 known_hosts、reject→yes+真实文件），不再无条件
  // StrictHostKeyChecking=no。
  const args = [
    '-p', String(host.port ?? 22),
    // Pin the actual destination and known_hosts identity to the endpoint
    // verified by the extension. Command-line options take precedence over
    // ~/.ssh/config HostName / HostKeyAlias / canonicalization directives.
    '-o', `HostName=${host.ip}`,
    '-o', `HostKeyAlias=${hostEntryName(host)}`,
    '-o', 'CanonicalizeHostname=no',
    '-o', 'CheckHostIP=no',
    ...hostKeyArgs(kind, options)
  ];
  // Some servers only offer legacy host keys (ssh-rsa/ssh-dss); OpenSSH 8.8+
  // rejects them by default, so re-enable them explicitly. The exact flags
  // are adapted to the installed client (see ssh-algorithms.ts), because old
  // OpenSSH rejects PubkeyAcceptedAlgorithms and OpenSSH 10+ rejects ssh-dss.
  args.push(...legacySshAlgorithmArgs());
  // An explicit KexAlgorithms list suppresses OpenSSH 10+'s post-quantum
  // warning that otherwise spams the terminal on legacy servers.
  args.push(...kexAlgorithmsArgs());
  // ControlMaster=auto reuses a healthy master and lets OpenSSH fall back to a
  // direct connection when the control socket cannot be used.
  args.push(...connectionReuseArgs(options));
  if (host.private_key_path) {
    args.push('-i', host.private_key_path);
  }
  if (remoteCwd) args.push('-t');
  args.push(`${host.user}@${host.ip}`);
  if (remoteCwd) {
    args.push(`cd -- ${shellQuote(remoteCwd)} && exec "\${SHELL:-/bin/sh}" -l`);
  }
  return args;
}

function remoteLoginCommand(remoteCwd: string): string {
  return `cd -- ${shellQuote(remoteCwd)} && exec "\${SHELL:-/bin/sh}" -l`;
}

function remoteExecCommand(remoteCwd: string, command: string): string {
  return `cd -- ${shellQuote(remoteCwd)} && exec "\${SHELL:-/bin/sh}" -lc ${shellQuote(command)}`;
}

class UnixAdapter implements PlatformAdapter {
  constructor(readonly kind: 'linux' | 'macos') {}

  terminal(host: HostConfig, remoteCwd?: string, options?: ConnectionOptions): CommandPlan {
    return { command: 'ssh', args: sshArgs(this.kind, host, remoteCwd, options) };
  }

  exec(host: HostConfig, remoteCwd: string, command: string, options?: ConnectionOptions): CommandPlan {
    const args = sshArgs(this.kind, host, undefined, options);
    args.push(remoteExecCommand(remoteCwd, command));
    return { command: 'ssh', args };
  }
}

class WslAdapter implements PlatformAdapter {
  readonly kind = 'wsl' as const;

  terminal(host: HostConfig, remoteCwd?: string, options?: ConnectionOptions): CommandPlan {
    const args = [host.name];
    if (remoteCwd) args.unshift('--tty');
    if (remoteCwd) args.push(remoteLoginCommand(remoteCwd));
    return {
      command: sshBridgePath(),
      args,
      env: {
        WSL_VPN_SSH_CONNECTION_REUSE: options?.reuseSshConnection === false ? '0' : '1',
        WSL_VPN_STRICT_HOST_KEY: hostKeyStrictValue(options?.hostKeyPolicy),
        ...(options?.hostKeyPolicy === 'prompt' && options?.userKnownHostsFile
          ? { WSL_VPN_KNOWN_HOSTS_FILE: options.userKnownHostsFile }
          : {}),
        ...(options?.bridgeConfigPath
          ? { WSL_VPN_SSH_CONFIG: options.bridgeConfigPath }
          : {}),
        ...(options?.bridgeMasterPassword
          ? { WSL_VPN_MASTER_PASSWORD: options.bridgeMasterPassword }
          : {}),
      }
    };
  }

  exec(host: HostConfig, remoteCwd: string, command: string, options?: ConnectionOptions): CommandPlan {
    return {
      command: sshBridgePath(),
      args: [host.name, remoteExecCommand(remoteCwd, command)],
      env: {
        WSL_VPN_SSH_CONNECTION_REUSE: options?.reuseSshConnection === false ? '0' : '1',
        WSL_VPN_STRICT_HOST_KEY: hostKeyStrictValue(options?.hostKeyPolicy),
        ...(options?.hostKeyPolicy === 'prompt' && options?.userKnownHostsFile
          ? { WSL_VPN_KNOWN_HOSTS_FILE: options.userKnownHostsFile }
          : {}),
        ...(options?.bridgeConfigPath
          ? { WSL_VPN_SSH_CONFIG: options.bridgeConfigPath }
          : {}),
      }
    };
  }
}

class WindowsAdapter implements PlatformAdapter {
  readonly kind = 'windows' as const;

  terminal(host: HostConfig, remoteCwd?: string, options?: ConnectionOptions): CommandPlan {
    return { command: 'ssh', args: sshArgs('windows', host, remoteCwd, options) };
  }

  exec(host: HostConfig, remoteCwd: string, command: string, options?: ConnectionOptions): CommandPlan {
    const args = sshArgs('windows', host, undefined, options);
    args.push(remoteExecCommand(remoteCwd, command));
    return { command: 'ssh', args };
  }
}

export function detectPlatform(platform = process.platform, release = os.release()): PlatformKind {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux' && /microsoft|wsl/i.test(release)) return 'wsl';
  if (platform === 'linux') return 'linux';
  throw new Error(`Unsupported platform: ${platform}`);
}

export function createPlatformAdapter(kind = detectPlatform()): PlatformAdapter {
  switch (kind) {
    case 'windows': return new WindowsAdapter();
    case 'macos': return new UnixAdapter('macos');
    case 'linux': return new UnixAdapter('linux');
    case 'wsl': return new WslAdapter();
  }
}
