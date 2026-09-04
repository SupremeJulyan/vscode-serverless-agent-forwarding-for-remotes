import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { redactSensitiveText } from './redact';

export interface McpCommandLogEntry {
  source: string;
  /** URL 中由 MCP 注册方声明的来源标签，仅用于日志/诊断。 */
  agentName?: string;
  agentPlatform?: string;
  mountName: string;
  remoteCwd: string;
  command: string;
}

export interface McpToolLogEntry {
  toolName: string;
  agentName?: string;
  agentPlatform?: string;
  input?: Record<string, unknown>;
}

export function mcpLogDirectory(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, '.safs', 'mcp_logs');
}

export function mcpLogFilePath(
  directory = mcpLogDirectory(), now = new Date()
): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return path.join(directory, `mcp-${year}-${month}-${day}.log`);
}

export function formatMcpCommandLogLine(
  entry: McpCommandLogEntry, now = new Date()
): string {
  const agent = entry.agentName?.trim().slice(0, 100)
    .replace(/[\]\r\n\t]/g, '_');
  const platform = entry.agentPlatform?.trim().replace(/[^a-z]/gi, '').slice(0, 10);
  // Shell syntax is too expressive for a deny-list redactor to prove that a
  // command contains no credentials. Persist only stable audit metadata; the
  // full command remains visible transiently in the VS Code output channel.
  const commandBytes = Buffer.byteLength(entry.command, 'utf8');
  const commandSha256 = createHash('sha256').update(entry.command).digest('hex');
  return `${now.toISOString()} [${entry.source}]${agent ? ` [agent=${agent}]` : ''}${platform ? ` [platform=${platform}]` : ''} [mount=${entry.mountName}] [cwd=${entry.remoteCwd}] command_bytes=${commandBytes} command_sha256=${commandSha256}`;
}

export async function appendMcpCommandLog(
  entry: McpCommandLogEntry,
  directory = mcpLogDirectory(),
  now = new Date()
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = mcpLogFilePath(directory, now);
  await appendFile(filePath, `${formatMcpCommandLogLine(entry, now)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return filePath;
}

function safeToolInput(toolName: string, input: Record<string, unknown> = {}): string {
  const summary: Record<string, unknown> = {};
  for (const key of [
    'mountName', 'host', 'workspaceRoot', 'path', 'sourcePath', 'targetPath',
    'remoteDirectory', 'remotePath', 'localPath', 'mode', 'limit', 'offset', 'length',
    'recursive', 'overwrite', 'query', 'remoteCwd'
  ]) {
    const value = input[key];
    if (typeof value === 'string') summary[key] = redactSensitiveText(value).slice(0, 500);
    else if (typeof value === 'number' || typeof value === 'boolean') summary[key] = value;
  }
  if (toolName === 'remote_write' && typeof input.content === 'string') {
    summary.contentBytes = Buffer.byteLength(input.content, 'utf8');
  }
  if (toolName === 'remote_edit' && Array.isArray(input.edits)) {
    summary.editCount = input.edits.length;
    const expectedHash = input.expectedHash;
    if (typeof expectedHash === 'string' && /^[0-9a-f]{64}$/i.test(expectedHash)) {
      summary.expectedHash = expectedHash.toLowerCase();
    }
  }
  if (toolName === 'remote_upload' && Array.isArray(input.localPaths)) {
    summary.localPaths = input.localPaths.slice(0, 20).flatMap((value) =>
      typeof value === 'string' ? [redactSensitiveText(value).slice(0, 500)] : []
    );
  }
  if (toolName === 'run_remote_command' && typeof input.command === 'string') {
    summary.commandBytes = Buffer.byteLength(input.command, 'utf8');
  }
  return JSON.stringify(summary);
}

export function formatMcpToolLogLine(entry: McpToolLogEntry, now = new Date()): string {
  const agent = entry.agentName?.trim().slice(0, 100).replace(/[\]\r\n\t]/g, '_');
  const platform = entry.agentPlatform?.trim().replace(/[^a-z]/gi, '').slice(0, 10);
  const tool = entry.toolName.trim().replace(/[^a-z0-9_.-]/gi, '_').slice(0, 100);
  return `${now.toISOString()} [tool=${tool || 'unknown'}]${agent ? ` [agent=${agent}]` : ' [agent=unknown]'}${platform ? ` [platform=${platform}]` : ''} args=${safeToolInput(tool, entry.input)}`;
}

export async function appendMcpToolLog(
  entry: McpToolLogEntry, directory = mcpLogDirectory(), now = new Date()
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = mcpLogFilePath(directory, now);
  await appendFile(filePath, `${formatMcpToolLogLine(entry, now)}\n`, {
    encoding: 'utf8', mode: 0o600
  });
  return filePath;
}
