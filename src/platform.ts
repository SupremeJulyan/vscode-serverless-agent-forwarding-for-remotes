import * as os from 'node:os';
import { HostConfig, ResolvedMount } from './config';

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
  sshfsCacheProfile?: 'fresh' | 'balanced' | 'fast';
}

export interface PlatformAdapter {
  readonly kind: PlatformKind;
  mount(remote: ResolvedMount, localPath: string, options?: ConnectionOptions): CommandPlan;
  unmount(remote: ResolvedMount, localPath: string): CommandPlan;
  lazyUnmount?(remote: ResolvedMount, localPath: string): CommandPlan;
  status(remote: ResolvedMount, localPath: string): CommandPlan;
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
        '-o', 'ControlPath=~/.ssh/serverless-remote-%C'
      ]
    : [];
}

function sshfsCacheArgs(options?: ConnectionOptions): string[] {
  switch (options?.sshfsCacheProfile) {
    case 'fresh':
      return [
        '-o', 'cache=no',
        '-o', 'attr_timeout=0',
        '-o', 'entry_timeout=0',
        '-o', 'negative_timeout=0'
      ];
    case 'fast':
      return [
        '-o', 'cache=yes',
        '-o', 'kernel_cache',
        '-o', 'cache_timeout=30',
        '-o', 'attr_timeout=30',
        '-o', 'entry_timeout=30',
        '-o', 'negative_timeout=5'
      ];
    case 'balanced':
      return [
        '-o', 'cache=yes',
        '-o', 'cache_timeout=5',
        '-o', 'attr_timeout=5',
        '-o', 'entry_timeout=5',
        '-o', 'negative_timeout=2'
      ];
    default:
      return [];
  }
}

function sshArgs(
  host: HostConfig, remoteCwd?: string, options?: ConnectionOptions
): string[] {
  const args = ['-p', String(host.port ?? 22), '-o', 'StrictHostKeyChecking=accept-new'];
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

function sshfsArgs(
  remote: ResolvedMount, localPath: string, options?: ConnectionOptions
): string[] {
  const host = remote.hostConfig;
  const args = [
    `${host.user}@${host.ip}:${remote.remote_path}`,
    localPath,
    '-p', String(host.port ?? 22),
    '-o', 'reconnect',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new'
  ];
  args.push(...connectionReuseArgs(options));
  args.push(...sshfsCacheArgs(options));
  if (host.private_key_path) {
    args.push('-o', `IdentityFile=${host.private_key_path}`);
  }
  return args;
}

class UnixAdapter implements PlatformAdapter {
  constructor(readonly kind: 'linux' | 'macos') {}
  mount(remote: ResolvedMount, localPath: string, options?: ConnectionOptions): CommandPlan {
    return { command: 'sshfs', args: sshfsArgs(remote, localPath, options), cwd: localPath };
  }
  unmount(_remote: ResolvedMount, localPath: string): CommandPlan {
    return this.kind === 'macos'
      ? { command: 'umount', args: [localPath] }
      : { command: 'fusermount3', args: ['-u', '--', localPath], stdin: '' };
  }
  lazyUnmount(_remote: ResolvedMount, localPath: string): CommandPlan {
    return this.kind === 'macos'
      ? { command: 'diskutil', args: ['unmount', localPath] }
      : { command: 'fusermount3', args: ['-uz', '--', localPath], stdin: '' };
  }
  status(_remote: ResolvedMount, localPath: string): CommandPlan {
    return this.kind === 'macos'
      ? {
          command: '/bin/sh',
          args: ['-c', 'mount | grep -F -- " on $1 (" >/dev/null', 'sshfs-mount-check', localPath]
        }
      : { command: 'mountpoint', args: ['-q', '--', localPath] };
  }
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
  mount(
    remote: ResolvedMount, _localPath: string, options?: ConnectionOptions
  ): CommandPlan {
    return {
      // A disconnected FUSE mount cannot be used as a process cwd: Node reports
      // that failure as a misleading `spawn <command> ENOENT`.
      command: 'sshfs-bridge', args: ['mount', remote.name],
      env: {
        SSHFS_BRIDGE_NO_TERMINAL: '1',
        ...(options?.reuseSshConnection === undefined ? {} : {
          WSL_VPN_SSH_CONNECTION_REUSE: options.reuseSshConnection ? '1' : '0'
        })
      },
      stdin: ''
    };
  }
  unmount(remote: ResolvedMount): CommandPlan {
    return { command: 'sshfs-bridge', args: ['unmount', remote.name], stdin: '' };
  }
  status(_remote: ResolvedMount, localPath: string): CommandPlan {
    return { command: 'mountpoint', args: ['-q', '--', localPath] };
  }
  terminal(host: HostConfig, _remoteCwd?: string, options?: ConnectionOptions): CommandPlan {
    const args = [host.name];
    if (_remoteCwd) args.unshift('--tty');
    if (_remoteCwd) args.push(remoteLoginCommand(_remoteCwd));
    return {
      command: 'ssh-bridge',
      args,
      ...(options?.reuseSshConnection === undefined ? {} : {
        env: {
          WSL_VPN_SSH_CONNECTION_REUSE: options.reuseSshConnection ? '1' : '0'
        }
      })
    };
  }
  exec(host: HostConfig, remoteCwd: string, command: string, options?: ConnectionOptions): CommandPlan {
    return {
      command: 'ssh-bridge',
      args: [host.name, remoteExecCommand(remoteCwd, command)],
      ...(options?.reuseSshConnection === undefined ? {} : {
        env: {
          WSL_VPN_SSH_CONNECTION_REUSE: options.reuseSshConnection ? '1' : '0'
        }
      })
    };
  }
}

function windowsUnc(remote: ResolvedMount): string {
  const host = remote.hostConfig;
  const rootRelative = remote.remote_path.startsWith('/');
  const provider = host.private_key_path
    ? (rootRelative ? 'sshfs.kr' : 'sshfs.k')
    : (rootRelative ? 'sshfs.r' : 'sshfs');
  const port = host.port && host.port !== 22 ? `!${host.port}` : '';
  const remotePath = remote.remote_path === '.'
    ? []
    : [remote.remote_path.replace(/^\/+/, '').replace(/\//g, '\\')];
  return [`\\\\${provider}\\${host.user}@${host.ip}${port}`, ...remotePath].join('\\');
}

const windowsPasswordMountScript = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class NetworkDrive {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct NETRESOURCE {
    public int dwScope, dwType, dwDisplayType, dwUsage;
    public string lpLocalName, lpRemoteName, lpComment, lpProvider;
  }
  [DllImport("mpr.dll", CharSet = CharSet.Unicode)]
  static extern int WNetAddConnection2(ref NETRESOURCE resource, string password, string username, int flags);
  public static void Mount(string localName, string remoteName, string username, string password) {
    var resource = new NETRESOURCE { dwType = 1, lpLocalName = localName, lpRemoteName = remoteName };
    int result = WNetAddConnection2(ref resource, password, username, 0);
    if (result != 0) throw new Win32Exception(result);
  }
}
'@
Add-Type -TypeDefinition $source
[NetworkDrive]::Mount(
  $env:SERVERLESS_REMOTE_DRIVE,
  $env:SERVERLESS_REMOTE_UNC,
  $env:SERVERLESS_REMOTE_USER,
  $env:SERVERLESS_REMOTE_PASSWORD
)
`;

class WindowsAdapter implements PlatformAdapter {
  readonly kind = 'windows' as const;
  private drive(localPath: string): string {
    if (!/^[a-zA-Z]:[\\/]?$/.test(localPath)) {
      throw new Error(`Windows SSHFS local_path must be a drive letter such as X:, got: ${localPath}`);
    }
    return localPath.slice(0, 2).toUpperCase();
  }
  mount(remote: ResolvedMount, localPath: string): CommandPlan {
    if (remote.hostConfig.private_key_path) {
      const host = remote.hostConfig;
      return {
        command: 'sshfs-win.exe',
        args: [
          'cmd', `${host.user}@${host.ip}:${remote.remote_path}`, this.drive(localPath),
          '-p', String(host.port ?? 22), '-o', `IdentityFile=${host.private_key_path}`,
          '-o', 'reconnect', '-o', 'StrictHostKeyChecking=accept-new'
        ]
      };
    }
    const drive = this.drive(localPath);
    const unc = windowsUnc(remote);
    if (remote.hostConfig.password) {
      return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsPasswordMountScript],
        env: {
          SERVERLESS_REMOTE_DRIVE: drive,
          SERVERLESS_REMOTE_UNC: unc,
          SERVERLESS_REMOTE_USER: remote.hostConfig.user,
          SERVERLESS_REMOTE_PASSWORD: remote.hostConfig.password
        },
        stdin: ''
      };
    }
    return { command: 'net', args: ['use', drive, unc, '/persistent:no'] };
  }
  unmount(_remote: ResolvedMount, localPath: string): CommandPlan {
    return { command: 'net', args: ['use', this.drive(localPath), '/delete', '/y'] };
  }
  status(_remote: ResolvedMount, localPath: string): CommandPlan {
    return { command: 'net', args: ['use', this.drive(localPath)] };
  }
  terminal(host: HostConfig, remoteCwd?: string, _options?: ConnectionOptions): CommandPlan {
    return { command: 'ssh', args: sshArgs(host, remoteCwd) };
  }
  exec(host: HostConfig, remoteCwd: string, command: string): CommandPlan {
    const args = sshArgs(host);
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
