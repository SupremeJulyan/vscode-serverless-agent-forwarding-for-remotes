import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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
  remote_terminal?: 'open';
}

export interface BridgeConfig {
  encrypt_passwords?: boolean;
  hosts: HostConfig[];
  mounts: MountConfig[];
}

export function deriveMounts(hosts: HostConfig[]): MountConfig[] {
  return hosts.map((host) => ({
    name: host.name,
    host: host.name,
    remote_path: '.',
    remote_terminal: 'open' as const
  }));
}

export function removeMountConfig(config: BridgeConfig, mountName: string): MountConfig {
  const index = config.mounts.findIndex((candidate) => candidate.name === mountName);
  if (index < 0) throw new Error(`Mount '${mountName}' no longer exists`);
  const [removed] = config.mounts.splice(index, 1);
  if (!config.mounts.some((mount) => mount.host === removed.host)) {
    config.hosts = config.hosts.filter((host) => host.name !== removed.host);
  }
  return removed;
}

export interface ResolvedMount extends MountConfig {
  hostConfig: HostConfig;
}

export interface SshLogin {
  user: string;
  host: string;
}

const configTemplate = {
  encrypt_passwords: true,
  hosts: []
};

const emptyConfig = `${JSON.stringify(configTemplate, null, 2)}\n`;

export function expandHome(value: string): string {
  if (/^[a-zA-Z]:[\\/]?$/.test(value)) {
    return `${value.slice(0, 2).toUpperCase()}\\`;
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

export function parseSshLogin(value: string): SshLogin | undefined {
  const match = /^([^@\s]+)@(?:\[([^\]]+)\]|([^@\s]+))$/.exec(value.trim());
  if (!match) return undefined;
  return { user: match[1], host: match[2] ?? match[3] };
}

export function parseConfig(value: unknown): BridgeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Config root must be an object');
  }
  const object = value as Record<string, unknown>;
  if (!Array.isArray(object.hosts)) {
    throw new Error('Config must contain a hosts array');
  }

  const hosts = object.hosts.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`hosts[${index}] must be an object`);
    }
    const host = item as Record<string, unknown>;
    const name = requireString(host.name, `hosts[${index}].name`);
    const ip = requireString(host.ip, `hosts[${index}].ip`);
    const user = requireString(host.user, `hosts[${index}].user`);
    return { name, ip, user, port: host.port, vpn: host.vpn, private_key_path: host.private_key_path, password: host.password } as HostConfig;
  });

  const hostNames = new Set<string>();
  for (const host of hosts) {
    if (hostNames.has(host.name)) {
      throw new Error(`Duplicate host name '${host.name}'`);
    }
    hostNames.add(host.name);
  }

  // 旧配置兼容：如果 mounts 数组存在则使用，否则从 hosts 派生
  const mounts: MountConfig[] = Array.isArray(object.mounts)
    ? object.mounts.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new Error(`mounts[${index}] must be an object`);
        }
        const mount = item as Record<string, unknown>;
        return {
          name: requireString(mount.name, `mounts[${index}].name`),
          host: requireString(mount.host, `mounts[${index}].host`),
          remote_path: requireString(mount.remote_path, `mounts[${index}].remote_path`),
          remote_terminal: 'open'
        } as MountConfig;
      })
    : deriveMounts(hosts);

  const names = new Set(hosts.map((host) => host.name));
  for (const mount of mounts) {
    if (!names.has(mount.host)) {
      throw new Error(`Mount '${mount.name}' references missing host '${mount.host}'`);
    }
  }
  return {
    encrypt_passwords: object.encrypt_passwords === false ? false : true,
    hosts,
    mounts
  };
}

export async function loadConfig(configPath: string): Promise<BridgeConfig> {
  const content = await fs.readFile(expandHome(configPath), 'utf8');
  return parseConfig(JSON.parse(content) as unknown);
}

export async function ensureConfigFile(configPath: string): Promise<string> {
  const resolvedPath = expandHome(configPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  try {
    // 初始配置文件可能含主机密码，创建时即收紧为仅当前用户可读写。
    await fs.writeFile(resolvedPath, emptyConfig, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
  }
  return resolvedPath;
}

export async function saveConfig(configPath: string, config: BridgeConfig): Promise<void> {
  const resolvedPath = expandHome(configPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(resolvedPath),
    `.config-${process.pid}-${Date.now()}.json`
  );
  try {
    const { mounts: _omitted, ...saved } = config;
    await fs.writeFile(temporaryPath, `${JSON.stringify(saved, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, resolvedPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export function resolveMount(config: BridgeConfig, mount: MountConfig): ResolvedMount {
  const hostConfig = config.hosts.find((host) => host.name === mount.host);
  if (!hostConfig) {
    throw new Error(`Mount '${mount.name}' references missing host '${mount.host}'`);
  }
  return { ...mount, hostConfig };
}
