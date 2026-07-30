import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentMcpServer } from '../src/agent-mcp';

test('serves forwarded mounts and remote execution through Streamable HTTP MCP', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = new AgentMcpServer(port, 'test-token', {
    listMounts: async () => [{
      name: 'project',
      localRoot: '/mnt/project',
      remoteRoot: '/srv/project',
      host: 'dev'
    }],
    run: async (input) => ({ ...input, exitCode: 0, stdout: 'ok' })
  });
  await server.start();
  const client = new Client({ name: 'agent-mcp-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ['list_forwarded_mounts', 'run_remote_command']
    );
    const listTool = tools.tools.find((tool) => tool.name === 'list_forwarded_mounts');
    const runTool = tools.tools.find((tool) => tool.name === 'run_remote_command');
    assert.match(listTool?.description ?? '', /cwd\/workspace is remote-backed/);
    assert.match(runTool?.description ?? '', /OS\/kernel\/hardware inspection/);
    assert.match(runTool?.description ?? '', /instead of the local shell/);
    const result = await client.callTool({
      name: 'run_remote_command',
      arguments: { command: 'npm test', cwd: '/mnt/project' }
    });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.equal(JSON.parse(text).exitCode, 0);
    assert.match(text, /npm test/);
  } finally {
    await client.close();
    await server.stop();
  }
});
