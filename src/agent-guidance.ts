import * as path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

export const agentGuidanceStart = '<!-- serverless-remote-ssh:agent-mcp:start -->';
export const agentGuidanceEnd = '<!-- serverless-remote-ssh:agent-mcp:end -->';

const managedGuidance = `${agentGuidanceStart}
## Serverless Remote SSH execution routing

- This workspace is backed by an SFTP remote connection. Before any shell command, operating-system inference, build, test, Git, package-manager, process, or service operation, call the \`serverless-remote\` MCP tool \`current_remote_workspace\` to discover the active mount and remote root.
- ALL commands that inspect the remote machine (OS, environment, builds, tests, Git, package managers, processes) MUST use \`run_remote_command\` — never the local shell.
- The \`remote_list\` / \`remote_read\` / \`remote_write\` / \`remote_search\` tools work with paths relative to the remote root.
- If the \`serverless-remote\` MCP tools are unavailable, stop and ask the user to enable Agent forwarding and restart the Agent. Do not substitute local execution for remote execution.
${agentGuidanceEnd}`;

export function upsertAgentGuidance(existing: string): string {
  const start = existing.indexOf(agentGuidanceStart);
  const end = existing.indexOf(agentGuidanceEnd);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error('AGENTS.md contains an incomplete Serverless Remote SSH managed block');
  }
  if (start !== -1) {
    const afterEnd = end + agentGuidanceEnd.length;
    return `${existing.slice(0, start)}${managedGuidance}${existing.slice(afterEnd)}`;
  }
  if (!existing) return `${managedGuidance}\n`;
  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${managedGuidance}\n`;
}

async function readableFile(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, 'utf8');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export interface AgentGuidanceResult {
  filePath: string;
  changed: boolean;
}

export async function maintainAgentGuidance(workspaceRoot: string): Promise<AgentGuidanceResult> {
  const overridePath = path.join(workspaceRoot, 'AGENTS.override.md');
  const filePath = await readableFile(overridePath)
    ? overridePath
    : path.join(workspaceRoot, 'AGENTS.md');
  let existing = '';
  try {
    existing = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const updated = upsertAgentGuidance(existing);
  if (updated === existing) return { filePath, changed: false };
  await writeFile(filePath, updated, 'utf8');
  return { filePath, changed: true };
}
