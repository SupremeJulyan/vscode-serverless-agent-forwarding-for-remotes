import * as os from 'node:os';
import { HostConfig, ResolvedMount } from './config';

export type PlatformKind = 'windows' | 'macos' | 'linux' | 'wsl';

export interface CommandPlan {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface PlatformAdapter {
  readonly kind: PlatformKind;
  dependencies(): string[];
  mount(remote: ResolvedMount, localPath: string): CommandPlan;
  unmount(remote: ResolvedMount, localPath: string): CommandPlan;
  status(remote: ResolvedMount, localPath: string): CommandPlan;
  terminal(host: HostConfig): CommandPlan;
}

function sshArgs(host: HostConfig): string[] {
  const args = ['-p', String(host.port ?? 22)];
  if (host.private_key_path) {
    args.push('-i', host.private_key_path);
  }
  args.push(`${host.user}@${host.ip}`);
  return args;
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
      : { command: 'fusermount3', args: ['-u', '--', localPath] };
  }
  status(_remote: ResolvedMount, localPath: string): CommandPlan {
    return this.kind === 'macos'
      ? {
          command: '/bin/sh',
          args: ['-c', 'mount | grep -F -- " on $1 (" >/dev/null', 'sshfs-mount-check', localPath]
        }
      : { command: 'mountpoint', args: ['-q', '--', localPath] };
  }
  terminal(host: HostConfig): CommandPlan { return { command: 'ssh', args: sshArgs(host) }; }
}

class WslAdapter implements PlatformAdapter {
  readonly kind = 'wsl' as const;
  dependencies(): string[] { return ['ssh-bridge', 'sshfs-bridge', 'mountpoint']; }
  mount(remote: ResolvedMount, localPath: string): CommandPlan {
    return {
      command: 'sshfs-bridge', args: ['mount', remote.name], cwd: localPath,
      env: { SSHFS_BRIDGE_NO_TERMINAL: '1' }
    };
  }
  unmount(remote: ResolvedMount): CommandPlan {
    return { command: 'sshfs-bridge', args: ['unmount', remote.name] };
  }
  status(_remote: ResolvedMount, localPath: string): CommandPlan {
    return { command: 'mountpoint', args: ['-q', '--', localPath] };
  }
  terminal(host: HostConfig): CommandPlan { return { command: 'ssh-bridge', args: [host.name] }; }
}

function windowsUnc(remote: ResolvedMount): string {
  const host = remote.hostConfig;
  const suffix = host.private_key_path ? 'kr' : 'r';
  const port = host.port && host.port !== 22 ? `!${host.port}` : '';
  const remotePath = remote.remote_path.replace(/^\/+/, '').replace(/\//g, '\\');
  return `\\\\sshfs.${suffix}\\${host.user}@${host.ip}${port}\\${remotePath}`;
}

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
    return { command: 'net', args: ['use', this.drive(localPath), windowsUnc(remote), '/persistent:no'] };
  }
  unmount(_remote: ResolvedMount, localPath: string): CommandPlan {
    return { command: 'net', args: ['use', this.drive(localPath), '/delete', '/y'] };
  }
  status(_remote: ResolvedMount, localPath: string): CommandPlan {
    return { command: 'net', args: ['use', this.drive(localPath)] };
  }
  terminal(host: HostConfig): CommandPlan { return { command: 'ssh', args: sshArgs(host) }; }
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
