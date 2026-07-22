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
  encrypt_passwords: true,
  hosts: [],
  mounts: []
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

export async function saveConfig(configPath: string, config: BridgeConfig): Promise<void> {
  const resolvedPath = expandHome(configPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(resolvedPath),
    `.config-${process.pid}-${Date.now()}.json`
  );
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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
