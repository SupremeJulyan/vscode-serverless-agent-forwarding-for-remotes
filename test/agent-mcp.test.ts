import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentMcpServer } from '../src/agent-mcp';

test('serves direct SFTP file and SSH command tools through MCP', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = new AgentMcpServer(port, 'test-token', {
    listFolders: async () => [{
      name: 'project',
      workspaceUri: 'safs://project/srv/project',
      remoteRoot: '/srv/project',
      host: 'dev'
    }],
    currentWorkspace: async () => ({
      name: 'project',
      workspaceUri: 'safs://project/srv/project',
      remoteRoot: '/srv/project',
      host: 'dev'
    }),
    list: async (input) => ({ ...input, entries: [] }),
    read: async (input) => ({ ...input, content: 'hello' }),
    write: async (input) => ({ ...input, bytes: input.content.length }),
    search: async (input) => ({ ...input, stdout: 'src/index.ts:1:hello' }),
    run: async (input) => ({ ...input, exitCode: 0, stdout: 'ok' })
  });
  await server.start();
  const client = new Client({ name: 'agent-mcp-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    assert.deepEqual(await client.listResources(), { resources: [] });
    assert.deepEqual(await client.listResourceTemplates(), { resourceTemplates: [] });
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'current_remote_workspace',
      'list_remote_folders',
      'remote_list',
      'remote_read',
      'remote_search',
      'remote_write',
      'resolve_workspace_execution',
      'run_remote_command'
    ]);
    const result = await client.callTool({
      name: 'remote_read',
      arguments: { mountName: 'project', path: 'README.md' }
    });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.equal(JSON.parse(text).content, 'hello');
    const route = await client.callTool({
      name: 'resolve_workspace_execution', arguments: {}
    });
    const routeText = (route.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.deepEqual(JSON.parse(routeText), {
      execution: 'remote',
      workspace: {
        name: 'project',
        workspaceUri: 'safs://project/srv/project',
        remoteRoot: '/srv/project',
        host: 'dev'
      },
      fileTools: ['remote_list', 'remote_read', 'remote_write', 'remote_search'],
      commandTool: 'run_remote_command',
      localFilesystemAllowed: false,
      localShellAllowed: false
    });
  } finally {
    await client.close();
    await server.stop();
  }
});

test('allocates independent ports for concurrent window MCP servers', async () => {
  const callbacks = (name: string) => ({
    listFolders: async () => [],
    currentWorkspace: async () => ({
      name,
      workspaceUri: `safs://${name}/srv/${name}`,
      remoteRoot: `/srv/${name}`,
      host: name
    }),
    list: async () => [],
    read: async () => ({}),
    write: async () => ({}),
    search: async () => ({}),
    run: async () => ({})
  });
  const first = new AgentMcpServer(0, 'first-token', callbacks('dev1'));
  const second = new AgentMcpServer(0, 'second-token', callbacks('dev2'));
  try {
    await Promise.all([first.start(), second.start()]);
    const firstUrl = new URL(first.url);
    const secondUrl = new URL(second.url);
    assert.notEqual(firstUrl.port, '0');
    assert.notEqual(secondUrl.port, '0');
    assert.notEqual(firstUrl.port, secondUrl.port);
    assert.equal(first.running, true);
    assert.equal(second.running, true);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});
