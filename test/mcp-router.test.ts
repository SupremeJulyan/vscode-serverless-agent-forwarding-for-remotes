import assert from 'node:assert/strict';
import * as http from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentHttpRouter } from '../src/agent-http-router';
import { AgentMcpServer } from '../src/agent-mcp';
import { DiscoveredAgentWorkspace } from '../src/agent-discovery';

function callbacks(label: string) {
  return {
    listFolders: async () => [],
    currentWorkspace: async () => ({
      name: 'A', workspaceUri: 'serverless-sftp://a/srv/a', remoteRoot: '/srv/a', host: 'dev'
    }),
    list: async (input: unknown) => ({ label, input }),
    read: async (input: unknown) => ({ label, input }),
    write: async (input: unknown) => ({ label, input }),
    search: async (input: unknown) => ({ label, input }),
    run: async (input: unknown) => ({ label, input })
  };
}

function record(instanceId: string, mcpUrl: string): DiscoveredAgentWorkspace {
  const updatedAt = new Date().toISOString();
  return {
    version: 1,
    instanceId,
    processId: process.pid,
    focused: true,
    execution: 'remote',
    workspaceUri: 'serverless-sftp://a/srv/a',
    mountName: 'A',
    remoteRoot: '/srv/a',
    host: 'dev',
    mcpUrl,
    updatedAt,
    updatedAtMs: Date.parse(updatedAt),
    discoveryFile: `${instanceId}.json`
  };
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(
    (error) => error ? reject(error) : resolve()
  ));
  return address.port;
}

test('fixed HTTP router follows a reconnected mount without changing the Agent URL', async () => {
  const first = new AgentMcpServer(0, 'first', callbacks('first'));
  const second = new AgentMcpServer(0, 'second', callbacks('second'));
  let workspaces: DiscoveredAgentWorkspace[] = [];
  const router = new AgentHttpRouter(await freePort(), 'router-token', {
    discover: () => workspaces
  });
  const client = new Client({ name: 'http-router-test', version: '1.0.0' });
  try {
    await Promise.all([first.start(), second.start()]);
    await router.start();
    assert.equal(router.leader, true);
    await client.connect(new StreamableHTTPClientTransport(new URL(router.url)));
    assert.deepEqual(await client.listResources(), { resources: [] });
    assert.deepEqual(await client.listResourceTemplates(), { resourceTemplates: [] });

    workspaces = [record('old-a', first.url)];
    const route = await client.callTool({
      name: 'resolve_workspace_execution', arguments: {}
    });
    const routeValue = JSON.parse((route.content as any[])[0].text);
    assert.equal(routeValue.execution, 'remote');
    assert.equal(routeValue.workspace.mountName, 'A');

    const connected = await client.callTool({
      name: 'remote_read', arguments: { path: 'README.md' }
    });
    assert.equal(JSON.parse((connected.content as any[])[0].text).label, 'first');

    workspaces = [];
    const disconnected = await client.callTool({
      name: 'remote_read', arguments: { path: 'README.md' }
    });
    assert.equal(disconnected.isError, true);
    assert.equal(JSON.parse((disconnected.content as any[])[0].text).code, 'NO_ACTIVE_REMOTE');

    workspaces = [record('new-a', second.url)];
    const reconnected = await client.callTool({
      name: 'remote_read', arguments: { path: 'README.md' }
    });
    assert.equal(JSON.parse((reconnected.content as any[])[0].text).label, 'second');
  } finally {
    await client.close();
    await Promise.allSettled([router.stop(), first.stop(), second.stop()]);
  }
});

test('another VS Code window takes over the fixed HTTP port after its leader exits', async () => {
  const port = await freePort();
  const first = new AgentHttpRouter(port, 'shared-token', { discover: () => [] });
  const second = new AgentHttpRouter(port, 'shared-token', { discover: () => [] });
  try {
    await first.start();
    await second.start();
    assert.equal(first.leader, true);
    assert.equal(second.leader, false);
    assert.equal(second.available, true);

    await first.stop();
    await second.start();
    assert.equal(second.leader, true);
    assert.equal(second.available, true);
  } finally {
    await Promise.allSettled([first.stop(), second.stop()]);
  }
});

test('fixed HTTP router rejects a port owned by an unrelated process', async () => {
  const port = await freePort();
  const unrelated = http.createServer((_request, response) => response.end('not a router'));
  await new Promise<void>((resolve) => unrelated.listen(port, '127.0.0.1', resolve));
  const router = new AgentHttpRouter(port, 'router-token');
  try {
    await assert.rejects(router.start(), /已被其他程序占用/);
  } finally {
    await new Promise<void>((resolve, reject) => unrelated.close(
      (error) => error ? reject(error) : resolve()
    ));
  }
});
