import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';

const maxRecordAgeMs = 35_000;

export interface AgentWorkspaceRecord {
  version: 1;
  instanceId: string;
  processId: number;
  focused: boolean;
  execution: 'remote';
  workspaceUri: string;
  mountName: string;
  remoteRoot: string;
  host: string;
  mcpUrl: string;
  updatedAt: string;
}

export function agentDiscoveryDirectory(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, '.safs', 'agent-workspaces');
}

function windowsPathToWsl(value: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value.trim());
  if (!match) return value.trim();
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

export function agentDiscoveryDirectories(): string[] {
  const homes = new Set([os.homedir(), process.env.USERPROFILE].filter(
    (value): value is string => Boolean(value)
  ));
  if (process.platform === 'linux' && /microsoft|wsl/i.test(os.release())) {
    try {
      const windowsHome = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', "[Environment]::GetFolderPath('UserProfile')"],
        { encoding: 'utf8', timeout: 2000, windowsHide: true }
      );
      homes.add(windowsPathToWsl(windowsHome));
    } catch {
      // Native WSL-only installations publish under the WSL home.
    }
  }
  return [...homes].map(agentDiscoveryDirectory);
}

export interface DiscoveredAgentWorkspace extends AgentWorkspaceRecord {
  discoveryFile: string;
  updatedAtMs: number;
}

export function readAgentWorkspaceRecord(
  filePath: string, now = Date.now()
): DiscoveredAgentWorkspace | undefined {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<AgentWorkspaceRecord>;
    const updatedAtMs = Date.parse(value.updatedAt ?? '');
    if (value.version !== 1 || value.execution !== 'remote' || !value.mcpUrl
      || !value.instanceId || !value.mountName || !Number.isFinite(updatedAtMs)
      || Math.abs(now - updatedAtMs) > maxRecordAgeMs) {
      return undefined;
    }
    return { ...value, updatedAtMs, discoveryFile: filePath } as DiscoveredAgentWorkspace;
  } catch {
    return undefined;
  }
}

export function discoverAgentWorkspaces(
  directories = agentDiscoveryDirectories(), now = Date.now()
): DiscoveredAgentWorkspace[] {
  const records: DiscoveredAgentWorkspace[] = [];
  for (const directory of directories) {
    try {
      for (const name of readdirSync(directory)) {
        if (!name.endsWith('.json')) continue;
        const record = readAgentWorkspaceRecord(path.join(directory, name), now);
        if (record) records.push(record);
      }
    } catch {
      // A missing discovery directory means no active remote window there.
    }
  }
  records.sort((left, right) =>
    Number(right.focused) - Number(left.focused) || right.updatedAtMs - left.updatedAtMs
  );
  return records;
}

export class AgentWorkspacePublisher {
  private readonly filePath: string;

  constructor(
    private readonly instanceId: string,
    private readonly directory = agentDiscoveryDirectory()
  ) {
    this.filePath = path.join(directory, `${instanceId}.json`);
  }

  async publish(record: Omit<AgentWorkspaceRecord, 'version' | 'instanceId' | 'processId' | 'updatedAt'>): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const value: AgentWorkspaceRecord = {
      version: 1,
      instanceId: this.instanceId,
      processId: process.pid,
      ...record,
      updatedAt: new Date().toISOString()
    };
    await writeFile(this.filePath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
  }

  async remove(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
