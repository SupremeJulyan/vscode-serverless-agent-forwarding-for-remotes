import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import { AgentWorkspacePublisher, agentDiscoveryDirectory } from '../src/agent-discovery';

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
    mcpServerName: 'serverless-remote-project',
    mcpUrl: 'http://127.0.0.1:9848/mcp?token=secret'
  });
  const filePath = path.join(directory, 'window-one.json');
  const value = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(value.version, 1);
  assert.equal(value.instanceId, 'window-one');
  assert.equal(value.execution, 'remote');
  assert.equal(value.mountName, 'project');
  assert.equal(value.mcpServerName, 'serverless-remote-project');
  assert.equal(typeof value.updatedAt, 'string');
  await publisher.remove();
  await assert.rejects(readFile(filePath, 'utf8'), { code: 'ENOENT' });
});
