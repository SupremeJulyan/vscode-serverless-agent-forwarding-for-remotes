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
      name: 'A', workspaceUri: 'safs://a/srv/a', workspaceRoot: '/srv/a', host: 'dev'
    }),
    currentFile: async (input: unknown) => ({ label, input }),
    list: async (input: unknown) => {
      if ((input as { path?: string }).path === 'forbidden') throw new Error('路径越界');
      return { label, input };
    },
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
    workspaceUri: 'safs://a/srv/a',
    mountName: 'A',
    workspaceRoot: '/srv/a',
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
      name: 'remote_list', arguments: { path: 'README.md' }
    });
    assert.equal(JSON.parse((connected.content as any[])[0].text).label, 'first');

    const rejected = await client.callTool({
      name: 'remote_list', arguments: { path: 'forbidden' }
    });
    assert.equal(rejected.isError, true);
    assert.deepEqual(JSON.parse((rejected.content as any[])[0].text), {
      code: 'REMOTE_TOOL_ERROR', message: '路径越界'
    });

    // current_remote_file is window-specific: the router forwards it to the
    // focused window's MCP server.
    const currentFile = await client.callTool({
      name: 'current_remote_file', arguments: {}
    });
    const currentFileValue = JSON.parse((currentFile.content as any[])[0].text);
    assert.equal(currentFileValue.label, 'first');
    assert.equal(currentFileValue.input.mountName, 'A');

    workspaces = [];
    const disconnected = await client.callTool({
      name: 'remote_list', arguments: { path: 'README.md' }
    });
    assert.equal(disconnected.isError, true);
    assert.equal(JSON.parse((disconnected.content as any[])[0].text).code, 'NO_ACTIVE_REMOTE');
    const disconnectedFile = await client.callTool({
      name: 'current_remote_file', arguments: {}
    });
    assert.equal(disconnectedFile.isError, true);
    assert.equal(JSON.parse((disconnectedFile.content as any[])[0].text).code, 'NO_ACTIVE_REMOTE');

    workspaces = [record('new-a', second.url)];
    const reconnected = await client.callTool({
      name: 'remote_list', arguments: { path: 'README.md' }
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

test('router refuses to forward to its own port (loop protection)', async () => {
  const port = await freePort();
  const router = new AgentHttpRouter(port, 'router-token', {
    discover: () => [record('self', `http://127.0.0.1:${port}/mcp?token=router-token`)]
  });
  const client = new Client({ name: 'http-router-test', version: '1.0.0' });
  try {
    await router.start();
    await client.connect(new StreamableHTTPClientTransport(new URL(router.url)));
    const result = await client.callTool({ name: 'remote_list', arguments: { path: 'x' } });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse((result.content as any[])[0].text).code, 'REMOTE_UNAVAILABLE');
  } finally {
    await client.close();
    await router.stop();
  }
});

test('router rejects requests marked as forwarded by another router', async () => {
  const port = await freePort();
  const router = new AgentHttpRouter(port, 'router-token', { discover: () => [] });
  await router.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp?token=router-token`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'x-safs-forwarded': '1'
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'list_remote_folders', arguments: {} }
      })
    });
    assert.equal(response.status, 403);
  } finally {
    await router.stop();
  }
});
