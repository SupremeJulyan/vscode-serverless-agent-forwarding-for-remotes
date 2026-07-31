import * as os from 'node:os';
import { HostConfig } from './config';

export type PlatformKind = 'windows' | 'macos' | 'linux' | 'wsl';

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
        '-o', `ControlPath=${os.homedir()}/.ssh/serverless-remote-%C`
      ]
    : [];
}

function sshArgs(host: HostConfig, remoteCwd?: string, options?: ConnectionOptions): string[] {
  const args = ['-p', String(host.port ?? 22), '-o', 'StrictHostKeyChecking=accept-new'];
  // Connection reuse conflicts with PTY allocation in interactive terminals:
  // "getsockname failed: Not a socket" — ssh's multiplexing code expects
  // a real socket handle but VS Code's terminal passes the SSH process
  // through a pseudo-terminal, not a raw socket.
  if (!remoteCwd) {
    args.push(...connectionReuseArgs(options));
  }
  if (host.private_key_path) args.push('-i', expandPrivateKey(host.private_key_path));
  if (remoteCwd) args.push('-t');
  args.push(`${host.user}@${host.ip}`);
  if (remoteCwd) {
    args.push(`cd -- ${shellQuote(remoteCwd)} && exec "\${SHELL:-/bin/sh}" -l`);
  }
  return args;
}

function expandPrivateKey(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return `${os.homedir()}/${value.slice(2)}`;
  return value;
}

function remoteCommand(remoteCwd: string, command: string): string {
  return `cd -- ${shellQuote(remoteCwd)} && exec "\${SHELL:-/bin/sh}" -lc ${
    shellQuote(command)
  }`;
}

class NativeAdapter implements PlatformAdapter {
  constructor(readonly kind: 'windows' | 'macos' | 'linux') {}

  terminal(host: HostConfig, remoteCwd?: string, options?: ConnectionOptions): CommandPlan {
    return { command: 'ssh', args: sshArgs(host, remoteCwd, options), cwd: os.homedir() };
  }

  exec(
    host: HostConfig, remoteCwd: string, command: string, options?: ConnectionOptions
  ): CommandPlan {
    const args = sshArgs(host, undefined, options);
    args.push(remoteCommand(remoteCwd, command));
    return { command: 'ssh', args };
  }
}

class WslAdapter implements PlatformAdapter {
  readonly kind = 'wsl' as const;

  terminal(host: HostConfig, remoteCwd?: string, options?: ConnectionOptions): CommandPlan {
    const args = [host.name];
    if (remoteCwd) args.unshift('--tty');
    if (remoteCwd) {
      args.push(`cd -- ${shellQuote(remoteCwd)} && exec "\${SHELL:-/bin/sh}" -l`);
    }
    return {
      command: 'ssh-bridge',
      args,
      cwd: os.homedir(),
      env: {
        WSL_VPN_SSH_CONNECTION_REUSE: options?.reuseSshConnection === false ? '0' : '1',
        ...(options?.bridgeMasterPassword
          ? { WSL_VPN_MASTER_PASSWORD: options.bridgeMasterPassword }
          : {})
      }
    };
  }

  exec(
    host: HostConfig, remoteCwd: string, command: string, options?: ConnectionOptions
  ): CommandPlan {
    return {
      command: 'ssh-bridge',
      args: [host.name, remoteCommand(remoteCwd, command)],
      env: {
        WSL_VPN_SSH_CONNECTION_REUSE: options?.reuseSshConnection === false ? '0' : '1'
      }
    };
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
  return kind === 'wsl' ? new WslAdapter() : new NativeAdapter(kind);
}
