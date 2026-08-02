import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

const pluginRoot = path.resolve('plugins/serverless-remote');

async function runHook(script: string, input: unknown, environment: NodeJS.ProcessEnv) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [path.join(pluginRoot, 'scripts', script)], {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('binds an active remote window at session start and blocks local tools', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'serverless-remote-plugin-'));
  const pluginData = path.join(home, 'plugin-data');
  const discovery = path.join(home, '.serverless-remote-ssh', 'agent-workspaces');
  await mkdir(discovery, { recursive: true });
  await writeFile(path.join(discovery, 'window-one.json'), JSON.stringify({
    version: 1,
    instanceId: 'window-one',
    processId: process.pid,
    focused: true,
    execution: 'remote',
    workspaceUri: 'serverless-sftp://project/srv/project',
    mountName: 'project',
    remoteRoot: '/srv/project',
    host: 'dev',
    mcpUrl: 'http://127.0.0.1:9848/mcp?token=secret',
    updatedAt: new Date().toISOString()
  }));
  const env = { ...process.env, HOME: home, USERPROFILE: '', PLUGIN_DATA: pluginData };
  const start = await runHook('session-start.cjs', {
    session_id: 'session-one', hook_event_name: 'SessionStart'
  }, env);
  assert.equal(start.exitCode, 0, start.stderr);
  const startResult = JSON.parse(start.stdout);
  assert.match(startResult.hookSpecificOutput.additionalContext, /resolve_workspace_execution/);
  assert.doesNotMatch(start.stdout, /token=secret/);

  const guard = await runHook('pre-tool-use.cjs', {
    session_id: 'session-one', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'git status' }
  }, env);
  assert.equal(guard.exitCode, 0, guard.stderr);
  assert.equal(
    JSON.parse(guard.stdout).hookSpecificOutput.permissionDecision,
    'deny'
  );
});

test('does not block sessions that were not bound to a remote window', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'serverless-remote-plugin-'));
  const result = await runHook('pre-tool-use.cjs', {
    session_id: 'local-session', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'git status' }
  }, { ...process.env, HOME: home, USERPROFILE: '', PLUGIN_DATA: path.join(home, 'data') });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, '');
});
