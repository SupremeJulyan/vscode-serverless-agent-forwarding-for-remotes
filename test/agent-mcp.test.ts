import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentMcpServer } from '../src/agent-mcp';

test('serves direct SFTP file and SSH command tools through MCP', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const audited: Array<{ toolName: string; agentName?: string }> = [];
  const server = new AgentMcpServer(port, 'test-token', {
    listFolders: async () => [{
      name: 'project',
      workspaceUri: 'safs://project/srv/project',
      workspaceRoot: '/srv/project',
      host: 'dev'
    }],
    currentWorkspace: async () => ({
      name: 'project',
      workspaceUri: 'safs://project/srv/project',
      workspaceRoot: '/srv/project',
      host: 'dev'
    }),
    currentFile: async (input) => ({ ...input, path: '/srv/project/README.md', dirty: false }),
    list: async (input) => {
      if (input.path === 'forbidden') throw new Error('路径越界');
      return { ...input, entries: [] };
    },
    write: async (input) => ({ ...input, bytes: input.content.length }),
    search: async (input) => ({ ...input, stdout: 'src/index.ts:1:hello' }),
    run: async (input) => ({ ...input, exitCode: 0, stdout: 'ok' }),
    audit: (entry) => audited.push(entry)
  });
  await server.start();
  const client = new Client({ name: 'agent-mcp-test', version: '1.0.0' });
  try {
    const taggedUrl = new URL(server.url);
    taggedUrl.searchParams.set('agent', 'codex');
    taggedUrl.searchParams.set('platform', 'wsl');
    await client.connect(new StreamableHTTPClientTransport(taggedUrl));
    assert.deepEqual(await client.listResources(), { resources: [] });
    assert.deepEqual(await client.listResourceTemplates(), { resourceTemplates: [] });
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'current_remote_file',
      'list_remote_folders',
      'remote_list',
      'remote_search',
      'remote_write',
      'resolve_workspace_execution',
      'run_remote_command'
    ]);
    const currentFile = await client.callTool({
      name: 'current_remote_file', arguments: { mountName: 'project' }
    });
    const currentFileText = (currentFile.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.equal(JSON.parse(currentFileText).path, '/srv/project/README.md');
    const route = await client.callTool({
      name: 'resolve_workspace_execution', arguments: {}
    });
    const routeText = (route.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.deepEqual(JSON.parse(routeText), {
      execution: 'remote',
      workspace: {
        mountName: 'project',
        workspaceRoot: '/srv/project',
        host: 'dev'
      },
      fileTools: ['remote_list', 'remote_write', 'remote_search', 'current_remote_file'],
      commandTool: 'run_remote_command',
      localFilesystemAllowed: false,
      localShellAllowed: false
    });
    const listed = await client.callTool({
      name: 'remote_list', arguments: { path: '.', limit: 10 }
    });
    const listedText = (listed.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.equal(JSON.parse(listedText).limit, 10);
    const rejected = await client.callTool({
      name: 'remote_list', arguments: { path: 'forbidden' }
    });
    assert.equal(rejected.isError, true);
    const rejectedText = (rejected.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.deepEqual(JSON.parse(rejectedText), {
      code: 'REMOTE_TOOL_ERROR', message: '路径越界'
    });
    assert.deepEqual(audited.map((entry) => entry.toolName), [
      'current_remote_file', 'resolve_workspace_execution', 'remote_list', 'remote_list'
    ]);
    assert.ok(audited.every((entry) => entry.agentName === 'codex'));
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
      workspaceRoot: `/srv/${name}`,
      host: name
    }),
    currentFile: async () => null,
    list: async () => [],
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
