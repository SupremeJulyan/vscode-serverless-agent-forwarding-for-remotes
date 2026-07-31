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
      workspaceUri: 'serverless-sftp://project/srv/project',
      remoteRoot: '/srv/project',
      host: 'dev'
    }],
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
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'current_remote_workspace',
      'list_remote_folders',
      'remote_list',
      'remote_read',
      'remote_search',
      'remote_write',
      'run_remote_command'
    ]);
    const result = await client.callTool({
      name: 'remote_read',
      arguments: { mountName: 'project', path: 'README.md' }
    });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.equal(JSON.parse(text).content, 'hello');
  } finally {
    await client.close();
    await server.stop();
  }
});
