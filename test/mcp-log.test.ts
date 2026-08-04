import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendMcpCommandLog, formatMcpCommandLogLine, mcpLogDirectory, mcpLogFilePath
} from '../src/mcp-log';

test('writes one escaped command line per entry under the per-day log file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-mcp-log-'));
  const now = new Date('2026-08-04T08:00:00.000Z');
  const first = await appendMcpCommandLog({
    source: 'mcp',
    mountName: 'prod',
    remoteCwd: '/srv/project',
    command: 'git status'
  }, directory, now);
  const second = await appendMcpCommandLog({
    source: 'remote_search',
    mountName: 'prod',
    remoteCwd: '/srv/project',
    command: 'grep -rn "line one\nline two" .'
  }, directory, now);

  assert.deepEqual(await readdir(directory), ['mcp-2026-08-04.log']);
  assert.equal(first, path.join(directory, 'mcp-2026-08-04.log'));
  assert.equal(second, first);
  const content = await readFile(first, 'utf8');
  assert.match(
    content,
    /^2026-08-04T08:00:00\.000Z \[mcp\] \[mount=prod\] \[cwd=\/srv\/project\] \$ git status\n/m
  );
  assert.match(
    content,
    /\[remote_search\].*\$ grep -rn "line one\\nline two" \.\n$/m
  );
});

test('redacts token query values in logged commands', () => {
  const line = formatMcpCommandLogLine({
    source: 'mcp',
    mountName: 'prod',
    remoteCwd: '/srv/project',
    command: 'curl "http://127.0.0.1:1234/mcp?token=secret&x=1"'
  }, new Date('2026-08-04T08:00:00.000Z'));
  assert.match(line, /token=<hidden>/);
  assert.ok(!line.includes('secret'));
});

test('defaults the log directory to ~/.safs/mcp_logs', () => {
  assert.equal(
    mcpLogDirectory('/home/alice'),
    path.join('/home/alice', '.safs', 'mcp_logs')
  );
  assert.equal(
    mcpLogFilePath('/home/alice/.safs/mcp_logs', new Date('2026-08-04T08:00:00.000Z')),
    path.join('/home/alice/.safs/mcp_logs', 'mcp-2026-08-04.log')
  );
});
