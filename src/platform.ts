import * as os from 'node:os';
import { HostConfig } from './config';
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
  /** safs.hostKeyChangedAction 设置值：accept/prompt→no、reject→yes */
  hostKeyPolicy?: 'accept' | 'prompt' | 'reject';
}

/**
 * 系统 ssh 路径的 StrictHostKeyChecking 映射（与 hostKeyChangedAction 设置一致）：
 * accept/prompt → no（MobaXterm 风格静默接受变化；系统 ssh 无法弹 VS Code 对话框，
 * accept-new 在负载均衡/VIP 后端切换时会拒绝已知主机的密钥变化，因此退化为 no）；
 * reject → yes（严格校验）。
 *
 * 注意：仅 StrictHostKeyChecking=no 不够 —— OpenSSH 对“已知主机密钥变化”即使放行
 * （continue_unsafe 分支）也会禁用密码/键盘交互认证，密码登录的第二次连接会报
 * Permission denied。因此 accept/prompt 还必须把 known_hosts 指向空设备
 * （/dev/null，Windows 为 NUL），让每次连接都视为“新主机”，永不进入密钥变化分支。
 */
function strictHostKeyCheckingOption(policy?: string): string {
  switch (policy) {
    case 'reject': return 'yes';
    default: return 'no';
  }
}

/**
 * accept/prompt 时把 known_hosts 指向空设备（/dev/null、Windows 为 NUL）：既不动
 * 用户真实的 ~/.ssh/known_hosts，又避免“密钥变化”检查（负载均衡 VIP 每次连接落到
 * 不同后端、密钥各不相同，OpenSSH 对已知密钥变化即使放行也会禁用密码认证）。
 * 同时 LogLevel=ERROR 压掉每次连接都会出现的 “Permanently added …” 提示噪音，
 * 真实错误（Permission denied、连接失败等）仍正常显示。reject 保留真实
 * known_hosts 与默认日志做严格校验。
 */
function hostKeyAcceptanceArgs(kind: PlatformKind, policy?: string): string[] {
  if (strictHostKeyCheckingOption(policy) === 'yes') return [];
  const device = kind === 'windows' ? 'NUL' : '/dev/null';
  return [
    '-o', `UserKnownHostsFile=${device}`,
    '-o', `GlobalKnownHostsFile=${device}`,
    '-o', 'LogLevel=ERROR'
  ];
}

export interface PlatformAdapter {
  readonly kind: PlatformKind;
  terminal(host: HostConfig, remoteCwd?: string, options?: ConnectionOptions): CommandPlan;
  exec(host: HostConfig, remoteCwd: string, command: string, options?: ConnectionOptions): CommandPlan;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
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
  // 主机密钥策略由 safs.hostKeyChangedAction 设置驱动（accept/prompt→no +
  // known_hosts 指向空设备 + LogLevel=ERROR / reject→yes），不再无条件
  // StrictHostKeyChecking=no。
  const args = [
    '-p', String(host.port ?? 22),
    '-o', `StrictHostKeyChecking=${strictHostKeyCheckingOption(options?.hostKeyPolicy)}`
  ];
  args.push(...hostKeyAcceptanceArgs(kind, options?.hostKeyPolicy));
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
        WSL_VPN_STRICT_HOST_KEY: strictHostKeyCheckingOption(options?.hostKeyPolicy),
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
        WSL_VPN_STRICT_HOST_KEY: strictHostKeyCheckingOption(options?.hostKeyPolicy),
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
