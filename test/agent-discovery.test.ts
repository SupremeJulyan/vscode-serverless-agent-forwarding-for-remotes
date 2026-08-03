import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import {
  AgentWorkspacePublisher, agentDiscoveryDirectory, discoverAgentWorkspaces
} from '../src/agent-discovery';

test('publishes a private, versioned remote workspace record and removes it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'serverless-remote-discovery-'));
  const directory = agentDiscoveryDirectory(home);
  const publisher = new AgentWorkspacePublisher('window-one', directory);
  await publisher.publish({
    focused: true,
    execution: 'remote',
    workspaceUri: 'serverless-sftp://project/srv/project',
    mountName: 'project',
    remoteRoot: '/srv/project',
    host: 'dev',
    mcpUrl: 'http://127.0.0.1:9848/mcp?token=secret'
  });
  const filePath = path.join(directory, 'window-one.json');
  const value = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(value.version, 1);
  assert.equal(value.instanceId, 'window-one');
  assert.equal(value.execution, 'remote');
  assert.equal(value.mountName, 'project');
  assert.equal(value.mcpServerName, undefined);
  assert.equal(typeof value.updatedAt, 'string');
  await publisher.remove();
  await assert.rejects(readFile(filePath, 'utf8'), { code: 'ENOENT' });
});

test('discovers focused fresh windows first and ignores stale records', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'serverless-remote-discovery-'));
  const directory = agentDiscoveryDirectory(home);
  const now = Date.now();
  const record = (instanceId: string, focused: boolean, updatedAtMs: number) => ({
    version: 1,
    instanceId,
    processId: 1,
    focused,
    execution: 'remote',
    workspaceUri: `serverless-sftp://${instanceId}/srv/${instanceId}`,
    mountName: instanceId,
    remoteRoot: `/srv/${instanceId}`,
    host: 'dev',
    mcpUrl: 'http://127.0.0.1:3000/mcp?token=secret',
    updatedAt: new Date(updatedAtMs).toISOString()
  });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'background.json'), JSON.stringify(
    record('background', false, now)
  ));
  await writeFile(path.join(directory, 'focused.json'), JSON.stringify(
    record('focused', true, now - 1_000)
  ));
  await writeFile(path.join(directory, 'stale.json'), JSON.stringify(
    record('stale', true, now - 36_000)
  ));
  assert.deepEqual(
    discoverAgentWorkspaces([directory], now).map((item) => item.mountName),
    ['focused', 'background']
  );
});
