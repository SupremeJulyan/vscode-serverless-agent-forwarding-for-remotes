import assert from 'node:assert/strict';
import * as http from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  AgentHttpRouter, agentTaggedMcpUrl, canonicalAgentCwd
} from '../src/agent-http-router';
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

function record(
  instanceId: string, mcpUrl: string,
  workspace: {
    mountName?: string; workspaceRoot?: string; host?: string; focused?: boolean;
    agentCwd?: string;
  } = {}
): DiscoveredAgentWorkspace {
  const updatedAt = new Date().toISOString();
  return {
    version: 1,
    instanceId,
    processId: process.pid,
    focused: workspace.focused ?? true,
    execution: 'remote',
    workspaceUri: 'safs://a/srv/a',
    mountName: workspace.mountName ?? 'A',
    workspaceRoot: workspace.workspaceRoot ?? '/srv/a',
    agentCwd: workspace.agentCwd,
    host: workspace.host ?? 'dev',
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

test('adds an encoded Agent source label without changing the router token', () => {
  const tagged = new URL(agentTaggedMcpUrl(
    'http://127.0.0.1:9848/mcp?token=secret', '  自定义 Agent  ', 'wsl'
  ));
  assert.equal(tagged.searchParams.get('token'), 'secret');
  assert.equal(tagged.searchParams.get('agent'), '自定义 Agent');
  assert.equal(tagged.searchParams.get('platform'), 'wsl');
});

test('normalizes Windows and WSL views of the same Agent cwd', () => {
  assert.equal(canonicalAgentCwd('C:\\Users\\Me\\SAFS\\'), '/mnt/c/users/me/safs');
  assert.equal(canonicalAgentCwd('/mnt/c/Users/Me/SAFS'), '/mnt/c/users/me/safs');
});

test('placeholder cwd binds its exact window instance and never falls back', async () => {
  const first = new AgentMcpServer(0, 'first', callbacks('first'));
  const second = new AgentMcpServer(0, 'second', callbacks('second'));
  let workspaces: DiscoveredAgentWorkspace[] = [];
  const router = new AgentHttpRouter(await freePort(), 'router-token', {
    discover: () => workspaces
  });
  const client = new Client({ name: 'window-agent', version: '1.0.0' });
  try {
    await Promise.all([first.start(), second.start()]);
    workspaces = [
      record('window-a', first.url, {
        host: 'host-a', workspaceRoot: '/srv/a', agentCwd: 'C:\\local\\agent-cwd\\a',
        focused: false
      }),
      record('window-b', second.url, {
        host: 'host-b', workspaceRoot: '/srv/b', agentCwd: '/local/agent-cwd/b',
        focused: true
      })
    ];
    await router.start();
    await client.connect(new StreamableHTTPClientTransport(new URL(router.url)));
    const selected = await client.callTool({
      name: 'safs_get_remote_workspace',
      arguments: { agentCwd: '/mnt/c/local/agent-cwd/a/project' }
    });
    const value = JSON.parse((selected.content as any[])[0].text);
    assert.equal(value.selectedAutomatically, true);
    assert.deepEqual(value.workspace, { host: 'host-a', workspaceRoot: '/srv/a' });

    workspaces = [workspaces[1]];
    const expired = await client.callTool({
      name: 'remote_list', arguments: { bindingId: value.bindingId, path: '.' }
    });
    assert.equal(expired.isError, true);
    assert.equal(JSON.parse((expired.content as any[])[0].text).code, 'WORKSPACE_BINDING_EXPIRED');
    const noFallback = await client.callTool({
      name: 'safs_get_remote_workspace',
      arguments: { agentCwd: '/mnt/c/local/agent-cwd/a/project' }
    });
    assert.equal(noFallback.isError, true);
    const noFallbackValue = JSON.parse((noFallback.content as any[])[0].text);
    assert.equal(noFallbackValue.code, 'WORKSPACE_SELECTION_REQUIRED');
    assert.deepEqual(noFallbackValue.candidates, [
      { workspaceId: 'window-b', workspaceRoot: '/srv/b', host: 'host-b' }
    ]);
  } finally {
    await client.close();
    await Promise.allSettled([router.stop(), first.stop(), second.stop()]);
  }
});

test('fixed HTTP router follows a reconnected mount without changing the Agent URL', async () => {
  const first = new AgentMcpServer(0, 'first', callbacks('first'));
  const second = new AgentMcpServer(0, 'second', callbacks('second'));
  let workspaces: DiscoveredAgentWorkspace[] = [];
  const routerAudits: string[] = [];
  const router = new AgentHttpRouter(await freePort(), 'router-token', {
    discover: () => workspaces,
    audit: (entry) => routerAudits.push(entry.toolName)
  });
  const client = new Client({ name: 'http-router-test', version: '1.0.0' });
  try {
    await Promise.all([first.start(), second.start()]);
    await router.start();
    assert.equal(router.leader, true);
    await client.connect(new StreamableHTTPClientTransport(
      new URL(agentTaggedMcpUrl(router.url, 'Codex', 'wsl'))
    ));
    assert.deepEqual(await client.listResources(), { resources: [] });
    assert.deepEqual(await client.listResourceTemplates(), { resourceTemplates: [] });

    workspaces = [record('old-a', first.url, { agentCwd: '/local/old-a' })];
    const route = await client.callTool({
      name: 'safs_get_remote_workspace', arguments: { agentCwd: '/local/old-a' }
    });
    const routeValue = JSON.parse((route.content as any[])[0].text);
    const bindingId = routeValue.bindingId as string;
    assert.match(bindingId, /^[a-f0-9]{16}$/);
    assert.deepEqual(routeValue.workspace, {
      workspaceRoot: '/srv/a', host: 'dev'
    });
    assert.equal(routeValue.selectedAutomatically, true);
    assert.deepEqual(routerAudits, ['safs_get_remote_workspace']);

    const connected = await client.callTool({
      name: 'remote_list', arguments: { bindingId, path: 'README.md' }
    });
    assert.equal(JSON.parse((connected.content as any[])[0].text).label, 'first');

    const ran = await client.callTool({
      name: 'run_remote_command', arguments: { bindingId, command: 'pwd' }
    });
    assert.equal(JSON.parse((ran.content as any[])[0].text).input.agentName, 'Codex');
    assert.equal(JSON.parse((ran.content as any[])[0].text).input.agentPlatform, 'wsl');

    const rejected = await client.callTool({
      name: 'remote_list', arguments: { bindingId, path: 'forbidden' }
    });
    assert.equal(rejected.isError, true);
    assert.deepEqual(JSON.parse((rejected.content as any[])[0].text), {
      code: 'REMOTE_TOOL_ERROR', message: '路径越界'
    });

    // current_remote_file is window-specific: the router forwards it to the
    // focused window's MCP server.
    const currentFile = await client.callTool({
      name: 'current_remote_file', arguments: { bindingId }
    });
    const currentFileValue = JSON.parse((currentFile.content as any[])[0].text);
    assert.equal(currentFileValue.label, 'first');
    assert.deepEqual(currentFileValue.input, {});

    workspaces = [];
    const disconnected = await client.callTool({
      name: 'remote_list', arguments: { bindingId, path: 'README.md' }
    });
    assert.equal(disconnected.isError, true);
    assert.equal(
      JSON.parse((disconnected.content as any[])[0].text).code,
      'WORKSPACE_BINDING_EXPIRED'
    );
    const disconnectedFile = await client.callTool({
      name: 'current_remote_file', arguments: { bindingId }
    });
    assert.equal(disconnectedFile.isError, true);
    assert.equal(
      JSON.parse((disconnectedFile.content as any[])[0].text).code,
      'WORKSPACE_BINDING_INVALID'
    );

    workspaces = [record('new-a', second.url, { agentCwd: '/local/new-a' })];
    const rebound = await client.callTool({
      name: 'safs_get_remote_workspace', arguments: { agentCwd: '/local/new-a' }
    });
    const reboundId = JSON.parse((rebound.content as any[])[0].text).bindingId;
    const reconnected = await client.callTool({
      name: 'remote_list', arguments: { bindingId: reboundId, path: 'README.md' }
    });
    assert.equal(JSON.parse((reconnected.content as any[])[0].text).label, 'second');
  } finally {
    await client.close();
    await Promise.allSettled([router.stop(), first.stop(), second.stop()]);
  }
});

test('unmatched cwd returns Agent-conversation candidates and accepts workspaceId', async () => {
  const first = new AgentMcpServer(0, 'first', callbacks('first'));
  const second = new AgentMcpServer(0, 'second', callbacks('second'));
  let workspaces: DiscoveredAgentWorkspace[] = [];
  const router = new AgentHttpRouter(await freePort(), 'router-token', {
    discover: () => workspaces
  });
  const client = new Client({ name: 'workspace-selection-test', version: '1.0.0' });
  try {
    await Promise.all([first.start(), second.start()]);
    workspaces = [
      record('focused', first.url, {
        mountName: 'A', host: 'host-a', workspaceRoot: '/srv/a', focused: true,
        agentCwd: '/local/agent-cwd/a'
      }),
      record('other', second.url, {
        mountName: 'B', host: 'host-b', workspaceRoot: '/srv/b', focused: false,
        agentCwd: '/local/agent-cwd/b'
      })
    ];
    await router.start();
    await client.connect(new StreamableHTTPClientTransport(
      new URL(agentTaggedMcpUrl(router.url, 'Codex', 'wsl'))
    ));

    const tools = await client.listTools();
    for (const tool of tools.tools) {
      assert.equal(JSON.stringify(tool.inputSchema).includes('mountName'), false);
      if (['current_remote_file', 'remote_list', 'remote_write', 'remote_search',
        'run_remote_command'].includes(tool.name)) {
        assert.ok((tool.inputSchema.required as string[] | undefined)?.includes('bindingId'));
      }
    }

    const unresolved = await client.callTool({
      name: 'safs_get_remote_workspace', arguments: { agentCwd: '/home/agent' }
    });
    assert.equal(unresolved.isError, true);
    const unresolvedValue = JSON.parse((unresolved.content as any[])[0].text);
    assert.equal(unresolvedValue.code, 'WORKSPACE_SELECTION_REQUIRED');
    assert.deepEqual(unresolvedValue.candidates, [
      { workspaceId: 'focused', workspaceRoot: '/srv/a', host: 'host-a' },
      { workspaceId: 'other', workspaceRoot: '/srv/b', host: 'host-b' }
    ]);
    const switchCandidates = await client.callTool({
      name: 'safs_get_remote_workspace',
      arguments: { agentCwd: '/local/agent-cwd/a', listCandidates: true }
    });
    assert.equal(switchCandidates.isError, true);
    const switchCandidatesValue = JSON.parse((switchCandidates.content as any[])[0].text);
    assert.equal(switchCandidatesValue.code, 'WORKSPACE_SELECTION_REQUIRED');
    assert.deepEqual(switchCandidatesValue.candidates, [
      { workspaceId: 'focused', workspaceRoot: '/srv/a', host: 'host-a' },
      { workspaceId: 'other', workspaceRoot: '/srv/b', host: 'host-b' }
    ]);
    const selected = await client.callTool({
      name: 'safs_get_remote_workspace', arguments: { workspaceId: 'other' }
    });
    assert.equal(selected.isError, true);
    assert.equal(
      JSON.parse((selected.content as any[])[0].text).code,
      'WORKSPACE_SELECTION_NOT_CONFIRMED'
    );
    const confirmed = await client.callTool({
      name: 'safs_get_remote_workspace',
      arguments: { workspaceId: 'other', userConfirmed: true }
    });
    const selectedValue = JSON.parse((confirmed.content as any[])[0].text);
    const bindingId = selectedValue.bindingId as string;
    assert.deepEqual(selectedValue.workspace, {
      workspaceRoot: '/srv/b', host: 'host-b'
    });
    assert.equal(selectedValue.selectedAutomatically, false);
    assert.equal(selectedValue.previousTaskCancelled, true);
    assert.equal(selectedValue.mustWaitForNewUserRequest, true);
    const bound = await client.callTool({
      name: 'remote_list', arguments: { bindingId, path: '.' }
    });
    assert.equal(JSON.parse((bound.content as any[])[0].text).label, 'second');

    const stale = await client.callTool({
      name: 'safs_get_remote_workspace',
      arguments: { workspaceId: 'missing', userConfirmed: true }
    });
    assert.equal(stale.isError, true);
    assert.equal(
      JSON.parse((stale.content as any[])[0].text).code,
      'REMOTE_WORKSPACE_NOT_FOUND'
    );
    const stillBound = await client.callTool({
      name: 'remote_list', arguments: { bindingId, path: '.' }
    });
    assert.equal(JSON.parse((stillBound.content as any[])[0].text).label, 'second');

    const switchedSelection = await client.callTool({
      name: 'safs_get_remote_workspace',
      arguments: { workspaceId: 'focused', userConfirmed: true }
    });
    const switchedId = JSON.parse((switchedSelection.content as any[])[0].text).bindingId;
    const switched = await client.callTool({
      name: 'remote_list', arguments: { bindingId: switchedId, path: '.' }
    });
    assert.equal(JSON.parse((switched.content as any[])[0].text).label, 'first');
    const originalBinding = await client.callTool({
      name: 'remote_list', arguments: { bindingId, path: '.' }
    });
    assert.equal(JSON.parse((originalBinding.content as any[])[0].text).label, 'second');
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
    const selected = await client.callTool({
      name: 'safs_get_remote_workspace',
      arguments: { workspaceId: 'self', userConfirmed: true }
    });
    const bindingId = JSON.parse((selected.content as any[])[0].text).bindingId;
    const result = await client.callTool({
      name: 'remote_list', arguments: { bindingId, path: 'x' }
    });
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
        params: { name: 'safs_get_remote_workspace', arguments: {} }
      })
    });
    assert.equal(response.status, 403);
  } finally {
    await router.stop();
  }
});
