import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export type RemoteTerminalMode = 'now' | 'open' | 'never';

export interface HostConfig {
  name: string;
  ip: string;
  user: string;
  port?: number;
  vpn?: boolean;
  private_key_path?: string;
  password?: string;
}

export interface MountConfig {
  name: string;
  host: string;
  remote_path: string;
  local_path?: string;
  local_paths?: Partial<Record<'windows' | 'macos' | 'linux' | 'wsl', string>>;
  remote_terminal?: RemoteTerminalMode;
}

export interface BridgeConfig {
  encrypt_passwords?: boolean;
  hosts: HostConfig[];
  mounts: MountConfig[];
}

export interface ResolvedMount extends MountConfig {
  hostConfig: HostConfig;
}

const configTemplate = {
  _comment: '请按 _field_help 和 _example 填写；hosts 与 mounts 可配置多项。以 _ 开头的说明字段不会参与连接。',
  encrypt_passwords: true,
  hosts: [],
  mounts: [],
  _field_help: {
    encrypt_passwords: '是否由配套 bridge 加密保存密码；建议保持 true。',
    hosts: {
      name: '主机唯一名称，供 mounts.host 引用。',
      ip: '服务器 IP 地址或域名。',
      user: 'SSH 登录用户名。',
      port: 'SSH 端口，通常为 22。',
      vpn: '是否通过 VPN 可见的网络连接。',
      private_key_path: '私钥路径；使用密钥登录时填写，例如 ~/.ssh/id_ed25519。',
      password: 'SSH 密码；与私钥按实际登录方式选择，避免提交到版本库。'
    },
    mounts: {
      name: '远程目录的显示名称。',
      host: '对应 hosts 中的 name。',
      remote_path: '服务器上的绝对目录路径。',
      local_path: '通用本地挂载路径；没有平台专用路径时使用。',
      local_paths: {
        windows: 'Windows 使用盘符，例如 X:。',
        macos: 'macOS 本地挂载目录。',
        linux: 'Linux 本地挂载目录。',
        wsl: 'WSL 本地挂载目录。'
      },
      remote_terminal: 'open：打开目录后连接终端；now：每次临时选择挂载目录；never：不打开终端。'
    }
  },
  _example: {
    hosts: [{
      name: 'dev',
      ip: '10.0.0.2',
      user: 'alice',
      port: 22,
      vpn: true,
      private_key_path: '~/.ssh/id_ed25519',
      password: '按需填写；使用私钥时删除此项'
    }],
    mounts: [{
      name: 'project',
      host: 'dev',
      remote_path: '/home/alice/project',
      local_path: '~/mnt/project',
      local_paths: {
        windows: 'X:',
        macos: '/Users/alice/mnt/project',
        linux: '/home/alice/mnt/project',
        wsl: '/home/alice/mnt/project'
      },
      remote_terminal: 'open'
    }]
  }
};

const emptyConfig = `${JSON.stringify(configTemplate, null, 2)}\n`;

export function expandHome(value: string): string {
  if (/^[a-zA-Z]:[\\/]?$/.test(value)) {
    return value.slice(0, 2).toUpperCase();
  }
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function parseConfig(value: unknown): BridgeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Config root must be an object');
  }
  const object = value as Record<string, unknown>;
  if (!Array.isArray(object.hosts) || !Array.isArray(object.mounts)) {
    throw new Error('Config must contain hosts and mounts arrays');
  }

  const hosts = object.hosts.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`hosts[${index}] must be an object`);
    }
    const host = item as Record<string, unknown>;
    return {
      ...host,
      name: requireString(host.name, `hosts[${index}].name`),
      ip: requireString(host.ip, `hosts[${index}].ip`),
      user: requireString(host.user, `hosts[${index}].user`)
    } as HostConfig;
  });

  const mounts = object.mounts.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`mounts[${index}] must be an object`);
    }
    const mount = item as Record<string, unknown>;
    const mode = mount.remote_terminal ?? 'open';
    if (mode !== 'now' && mode !== 'open' && mode !== 'never') {
      throw new Error(`mounts[${index}].remote_terminal must be now, open, or never`);
    }
    return {
      ...mount,
      name: requireString(mount.name, `mounts[${index}].name`),
      host: requireString(mount.host, `mounts[${index}].host`),
      remote_path: requireString(mount.remote_path, `mounts[${index}].remote_path`),
      remote_terminal: mode
    } as MountConfig;
  });

  const names = new Set(hosts.map((host) => host.name));
  for (const mount of mounts) {
    if (!names.has(mount.host)) {
      throw new Error(`Mount '${mount.name}' references missing host '${mount.host}'`);
    }
  }
  return { encrypt_passwords: object.encrypt_passwords === true, hosts, mounts };
}

export async function loadConfig(configPath: string): Promise<BridgeConfig> {
  const content = await fs.readFile(expandHome(configPath), 'utf8');
  return parseConfig(JSON.parse(content) as unknown);
}

export async function ensureConfigFile(configPath: string): Promise<string> {
  const resolvedPath = expandHome(configPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  try {
    await fs.writeFile(resolvedPath, emptyConfig, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
  }
  return resolvedPath;
}

export function resolveMount(config: BridgeConfig, mount: MountConfig): ResolvedMount {
  const hostConfig = config.hosts.find((host) => host.name === mount.host);
  if (!hostConfig) {
    throw new Error(`Mount '${mount.name}' references missing host '${mount.host}'`);
  }
  return { ...mount, hostConfig };
}
