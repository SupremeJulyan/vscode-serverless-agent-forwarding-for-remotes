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

export interface PlatformAdapter {
  readonly kind: PlatformKind;
  dependencies(): string[];
  mount(remote: ResolvedMount, localPath: string): CommandPlan;
  unmount(remote: ResolvedMount, localPath: string): CommandPlan;
  lazyUnmount?(remote: ResolvedMount, localPath: string): CommandPlan;
  status(remote: ResolvedMount, localPath: string): CommandPlan;
  terminal(host: HostConfig, remoteCwd?: string): CommandPlan;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function sshArgs(host: HostConfig, remoteCwd?: string): string[] {
  const args = ['-p', String(host.port ?? 22), '-o', 'StrictHostKeyChecking=accept-new'];
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

function sshfsArgs(remote: ResolvedMount, localPath: string): string[] {
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
  if (host.private_key_path) {
    args.push('-o', `IdentityFile=${host.private_key_path}`);
  }
  return args;
}

class UnixAdapter implements PlatformAdapter {
  constructor(readonly kind: 'linux' | 'macos') {}
  dependencies(): string[] {
    return this.kind === 'macos' ? ['ssh', 'sshfs', 'umount'] : ['ssh', 'sshfs', 'mountpoint', 'fusermount3'];
  }
  mount(remote: ResolvedMount, localPath: string): CommandPlan {
    return { command: 'sshfs', args: sshfsArgs(remote, localPath), cwd: localPath };
  }
  unmount(_remote: ResolvedMount, localPath: string): CommandPlan {
    return this.kind === 'macos'
      ? { command: 'umount', args: [localPath] }
      : { command: 'fusermount3', args: ['-u', '--', localPath], stdin: '' };
  }
  lazyUnmount(_remote: ResolvedMount, localPath: string): CommandPlan {
    return { command: 'fusermount3', args: ['-uz', '--', localPath], stdin: '' };
  }
  status(_remote: ResolvedMount, localPath: string): CommandPlan {
    return this.kind === 'macos'
      ? {
          command: '/bin/sh',
          args: ['-c', 'mount | grep -F -- " on $1 (" >/dev/null', 'sshfs-mount-check', localPath]
        }
      : { command: 'mountpoint', args: ['-q', '--', localPath] };
  }
  terminal(host: HostConfig, remoteCwd?: string): CommandPlan {
    return { command: 'ssh', args: sshArgs(host, remoteCwd) };
  }
}

class WslAdapter implements PlatformAdapter {
  readonly kind = 'wsl' as const;
  dependencies(): string[] { return ['ssh-bridge', 'sshfs-bridge', 'mountpoint']; }
  mount(remote: ResolvedMount, localPath: string): CommandPlan {
    return {
      command: 'sshfs-bridge', args: ['mount', remote.name], cwd: localPath,
      env: { SSHFS_BRIDGE_NO_TERMINAL: '1' }, stdin: ''
    };
  }
  unmount(remote: ResolvedMount): CommandPlan {
    return { command: 'sshfs-bridge', args: ['unmount', remote.name], stdin: '' };
  }
  status(_remote: ResolvedMount, localPath: string): CommandPlan {
    return { command: 'mountpoint', args: ['-q', '--', localPath] };
  }
  terminal(host: HostConfig, _remoteCwd?: string): CommandPlan {
    const args = [host.name];
    if (_remoteCwd) args.unshift('--tty');
    if (_remoteCwd) args.push(remoteLoginCommand(_remoteCwd));
    return { command: 'ssh-bridge', args };
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
  dependencies(): string[] { return ['ssh', 'net', 'sshfs-win.exe']; }
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
  terminal(host: HostConfig, remoteCwd?: string): CommandPlan {
    return { command: 'ssh', args: sshArgs(host, remoteCwd) };
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
