import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';

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
  return path.join(homeDirectory, '.serverless-remote-ssh', 'agent-workspaces');
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
