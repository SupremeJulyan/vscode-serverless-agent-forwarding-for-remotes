import * as os from 'node:os';
import * as path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import { redactSensitiveText } from './redact';

export interface McpCommandLogEntry {
  source: string;
  mountName: string;
  remoteCwd: string;
  command: string;
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
  const redacted = redactSensitiveText(entry.command);
  const escaped = redacted
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `${now.toISOString()} [${entry.source}] [mount=${entry.mountName}] [cwd=${entry.remoteCwd}] $ ${escaped}`;
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
