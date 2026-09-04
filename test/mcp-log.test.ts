import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendMcpCommandLog, appendMcpToolLog, formatMcpCommandLogLine,
  formatMcpToolLogLine, mcpLogDirectory, mcpLogFilePath
} from '../src/mcp-log';

test('writes command hashes without persisting command content', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-mcp-log-'));
  const now = new Date('2026-08-04T08:00:00.000Z');
  const first = await appendMcpCommandLog({
    source: 'mcp',
    agentName: 'MyAgent',
    agentPlatform: 'linux',
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
  assert.match(content, /\[mcp\].*command_bytes=10 command_sha256=[0-9a-f]{64}/);
  assert.match(content, /\[remote_search\].*command_bytes=30 command_sha256=[0-9a-f]{64}/);
  assert.equal(content.includes('git status'), false);
  assert.equal(content.includes('line one'), false);
});

test('never persists token-bearing command text', () => {
  const line = formatMcpCommandLogLine({
    source: 'mcp',
    mountName: 'prod',
    remoteCwd: '/srv/project',
    command: 'curl "http://127.0.0.1:1234/mcp?token=secret&x=1"'
  }, new Date('2026-08-04T08:00:00.000Z'));
  assert.match(line, /command_sha256=[0-9a-f]{64}/);
  assert.equal(line.includes('token='), false);
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

test('logs every tool with Agent identity without storing file content', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-mcp-tool-log-'));
  const now = new Date('2026-08-25T09:00:00.000Z');
  const line = formatMcpToolLogLine({
    toolName: 'remote_write', agentName: 'codex', agentPlatform: 'wsl',
    input: { mountName: 'prod', path: 'notes.txt', content: 'top secret content' }
  }, now);
  assert.match(line, /^2026-08-25T09:00:00\.000Z \[tool=remote_write\] \[agent=codex\] \[platform=wsl\]/);
  assert.match(line, /"mountName":"prod"/);
  assert.match(line, /"path":"notes.txt"/);
  assert.match(line, /"contentBytes":18/);
  assert.equal(line.includes('top secret content'), false);

  const editLine = formatMcpToolLogLine({
    toolName: 'remote_edit', agentName: 'codex',
    input: {
      path: 'notes.txt', expectedHash: 'a'.repeat(64),
      edits: [{ oldText: 'private source', newText: 'replacement source' }]
    }
  }, now);
  assert.match(editLine, /"editCount":1/);
  assert.match(editLine, /"expectedHash":"a{64}"/);
  assert.equal(editLine.includes('private source'), false);
  assert.equal(editLine.includes('replacement source'), false);

  const file = await appendMcpToolLog({
    toolName: 'remote_list', agentName: 'opencode', agentPlatform: 'linux',
    input: { mountName: 'yx', path: '.' }
  }, directory, now);
  assert.match(await readFile(file, 'utf8'), /\[tool=remote_list\] \[agent=opencode\]/);
});

test('untagged MCP URLs are explicitly logged as unknown Agent', () => {
  assert.match(formatMcpToolLogLine({
    toolName: 'safs_get_remote_workspace', input: {}
  }), /\[agent=unknown\]/);
});
