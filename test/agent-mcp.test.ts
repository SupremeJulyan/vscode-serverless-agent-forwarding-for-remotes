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
    read: async (input) => ({ ...input, content: 'hello', truncated: false }),
    edit: async (input) => ({ ...input, replacements: input.edits.length }),
    write: async (input) => ({ ...input, bytes: input.content.length }),
    delete: async (input) => ({ ...input, deleted: true }),
    chmod: async (input) => ({ ...input, changed: true }),
    move: async (input) => ({ ...input, moved: true }),
    upload: async (input) => ({ ...input, completed: true }),
    download: async (input) => ({ ...input, completed: true }),
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
      'remote_chmod',
      'remote_delete',
      'remote_download',
      'remote_edit',
      'remote_list',
      'remote_move',
      'remote_read',
      'remote_search',
      'remote_upload',
      'remote_write',
      'run_remote_command',
      'safs_get_remote_workspace'
    ]);
    const currentFile = await client.callTool({
      name: 'current_remote_file', arguments: {}
    });
    const currentFileText = (currentFile.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.equal(JSON.parse(currentFileText).path, '/srv/project/README.md');
    const route = await client.callTool({
      name: 'safs_get_remote_workspace', arguments: {}
    });
    const routeText = (route.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.deepEqual(JSON.parse(routeText), {
      workspace: {
        workspaceRoot: '/srv/project',
        host: 'dev'
      },
      localFilesystemAllowed: false,
      localShellAllowed: false
    });
    const listed = await client.callTool({
      name: 'remote_list', arguments: { path: '.', limit: 10 }
    });
    const listedText = (listed.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.equal(JSON.parse(listedText).limit, 10);
    const read = await client.callTool({
      name: 'remote_read', arguments: { path: 'src/index.ts', offset: 10, length: 20 }
    });
    const readText = (read.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.deepEqual(JSON.parse(readText), {
      path: 'src/index.ts', offset: 10, length: 20, content: 'hello', truncated: false
    });
    const edited = await client.callTool({
      name: 'remote_edit', arguments: {
        path: 'src/index.ts',
        edits: [{ oldText: 'hello', newText: 'world' }]
      }
    });
    assert.equal(JSON.parse((edited.content as any[])[0].text).replacements, 1);
    const downloaded = await client.callTool({
      name: 'remote_download', arguments: {
        remotePath: 'dist/app.bin', localPath: '/tmp/app.bin'
      }
    });
    const downloadedText = (downloaded.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.deepEqual(JSON.parse(downloadedText), {
      remotePath: 'dist/app.bin', localPath: '/tmp/app.bin', agentPlatform: 'wsl', completed: true
    });
    const uploaded = await client.callTool({
      name: 'remote_upload', arguments: {
        localPaths: ['/tmp/app.bin'], remoteDirectory: 'dist'
      }
    });
    const uploadedText = (uploaded.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.deepEqual(JSON.parse(uploadedText), {
      localPaths: ['/tmp/app.bin'], remoteDirectory: 'dist',
      agentPlatform: 'wsl', completed: true
    });
    const deleted = await client.callTool({
      name: 'remote_delete', arguments: { path: 'dist/old.bin', recursive: false }
    });
    assert.equal(JSON.parse((deleted.content as any[])[0].text).deleted, true);
    const chmod = await client.callTool({
      name: 'remote_chmod', arguments: { path: 'scripts/build.sh', mode: '755' }
    });
    assert.equal(JSON.parse((chmod.content as any[])[0].text).mode, '755');
    const moved = await client.callTool({
      name: 'remote_move', arguments: {
        sourcePath: 'old.txt', targetPath: 'new.txt', overwrite: false
      }
    });
    assert.equal(JSON.parse((moved.content as any[])[0].text).moved, true);
    const rejected = await client.callTool({
      name: 'remote_list', arguments: { path: 'forbidden' }
    });
    assert.equal(rejected.isError, true);
    const rejectedText = (rejected.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.deepEqual(JSON.parse(rejectedText), {
      code: 'REMOTE_TOOL_ERROR', message: '路径越界'
    });
    assert.deepEqual(audited.map((entry) => entry.toolName), [
      'current_remote_file', 'safs_get_remote_workspace', 'remote_list',
      'remote_read', 'remote_edit', 'remote_download', 'remote_upload', 'remote_delete',
      'remote_chmod', 'remote_move', 'remote_list'
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
    read: async () => ({}),
    edit: async () => ({}),
    write: async () => ({}),
    delete: async () => ({}),
    chmod: async () => ({}),
    move: async () => ({}),
    upload: async () => ({}),
    download: async () => ({}),
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
