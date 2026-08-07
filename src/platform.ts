import * as os from 'node:os';
import { HostConfig } from './config';
import { legacySshAlgorithmArgs } from './ssh-algorithms';
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
  return options?.reuseSshConnection
    ? [
        '-o', 'ControlMaster=auto',
        '-o', 'ControlPersist=10m',
        '-o', 'ControlPath=~/.ssh/safs-%C'
      ]
    : [];
}

function sshArgs(host: HostConfig, remoteCwd?: string, options?: ConnectionOptions): string[] {
  const args = ['-p', String(host.port ?? 22), '-o', 'StrictHostKeyChecking=accept-new'];
  // Some servers only offer legacy host keys (ssh-rsa/ssh-dss); OpenSSH 8.8+
  // rejects them by default, so re-enable them explicitly. The exact flags
  // are adapted to the installed client (see ssh-algorithms.ts), because old
  // OpenSSH rejects PubkeyAcceptedAlgorithms and OpenSSH 10+ rejects ssh-dss.
  args.push(...legacySshAlgorithmArgs());
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
    return { command: 'ssh', args: sshArgs(host, remoteCwd, options) };
  }

  exec(host: HostConfig, remoteCwd: string, command: string, options?: ConnectionOptions): CommandPlan {
    const args = sshArgs(host, undefined, options);
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
    return { command: 'ssh', args: sshArgs(host, remoteCwd, options) };
  }

  exec(host: HostConfig, remoteCwd: string, command: string, options?: ConnectionOptions): CommandPlan {
    const args = sshArgs(host, undefined, options);
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
