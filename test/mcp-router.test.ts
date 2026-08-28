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

test('Agent cwd automatically binds its window and never falls back after it closes', async () => {
  const first = new AgentMcpServer(0, 'first', callbacks('first'));
  const second = new AgentMcpServer(0, 'second', callbacks('second'));
  let workspaces: DiscoveredAgentWorkspace[] = [];
  let pickerCalls = 0;
  const router = new AgentHttpRouter(await freePort(), 'router-token', {
    discover: () => workspaces,
    selectWorkspace: async () => { pickerCalls += 1; return workspaces[1]; }
  });
  const client = new Client({ name: 'window-agent', version: '1.0.0' });
  try {
    await Promise.all([first.start(), second.start()]);
    workspaces = [
      record('window-a', first.url, {
        host: 'host-a', workspaceRoot: '/srv/a', agentCwd: 'C:\\local\\agent-cwd\\a'
      }),
      record('window-b', second.url, {
        host: 'host-b', workspaceRoot: '/srv/b', agentCwd: '/local/agent-cwd/b'
      })
    ];
    await router.start();
    await client.connect(new StreamableHTTPClientTransport(
      new URL(agentTaggedMcpUrl(router.url, 'Codex', 'linux'))
    ));
    const missingCwd = await client.callTool({
      name: 'safs_get_remote_workspace', arguments: {}
    });
    assert.equal(missingCwd.isError, true);
    assert.equal(JSON.parse((missingCwd.content as any[])[0].text).code, 'AGENT_CWD_REQUIRED');
    assert.equal(pickerCalls, 0);
    const selected = await client.callTool({
      name: 'safs_get_remote_workspace', arguments: { agentCwd: '/mnt/c/local/agent-cwd/a' }
    });
    const value = JSON.parse((selected.content as any[])[0].text);
    assert.equal(pickerCalls, 0);
    assert.equal(value.selectedAutomatically, true);
    assert.equal(value.selectedInVsCode, false);
    assert.deepEqual(value.workspace, { host: 'host-a', workspaceRoot: '/srv/a' });

    workspaces = [workspaces[1]];
    const expired = await client.callTool({
      name: 'remote_list', arguments: { bindingId: value.bindingId, path: '.' }
    });
    assert.equal(expired.isError, true);
    assert.equal(JSON.parse((expired.content as any[])[0].text).code, 'WORKSPACE_BINDING_EXPIRED');
    const noFallback = await client.callTool({
      name: 'safs_get_remote_workspace', arguments: { agentCwd: '/mnt/c/local/agent-cwd/a' }
    });
    assert.equal(noFallback.isError, true);
    assert.equal(
      JSON.parse((noFallback.content as any[])[0].text).code,
      'WORKSPACE_SOURCE_NOT_FOUND'
    );
    assert.equal(pickerCalls, 0);
  } finally {
    await client.close();
    await Promise.allSettled([router.stop(), first.stop(), second.stop()]);
  }
});

test('shared placeholder cwd uses one focused match and otherwise refuses to guess', async () => {
  const port = await freePort();
  let workspaces = [
    record('background', 'http://127.0.0.1:1/mcp', {
      agentCwd: '/local/shared', focused: false
    }),
    record('focused', 'http://127.0.0.1:2/mcp', {
      agentCwd: '/local/shared', focused: true
    })
  ];
  const router = new AgentHttpRouter(port, 'router-token', { discover: () => workspaces });
  const client = new Client({ name: 'shared-cwd-test', version: '1.0.0' });
  try {
    await router.start();
    await client.connect(new StreamableHTTPClientTransport(new URL(router.url)));
    const selected = await client.callTool({
      name: 'safs_get_remote_workspace', arguments: { agentCwd: '/local/shared' }
    });
    assert.equal(JSON.parse((selected.content as any[])[0].text).selectedAutomatically, true);

    workspaces = workspaces.map((workspace) => ({ ...workspace, focused: false }));
    const ambiguous = await client.callTool({
      name: 'safs_get_remote_workspace', arguments: { agentCwd: '/local/shared' }
    });
    assert.equal(ambiguous.isError, true);
    assert.equal(
      JSON.parse((ambiguous.content as any[])[0].text).code,
      'WORKSPACE_SOURCE_AMBIGUOUS'
    );
  } finally {
    await client.close();
    await router.stop();
  }
});

test('fixed HTTP router follows a reconnected mount without changing the Agent URL', async () => {
  const first = new AgentMcpServer(0, 'first', callbacks('first'));
  const second = new AgentMcpServer(0, 'second', callbacks('second'));
  let workspaces: DiscoveredAgentWorkspace[] = [];
  const routerAudits: string[] = [];
  const router = new AgentHttpRouter(await freePort(), 'router-token', {
    discover: () => workspaces,
    selectWorkspace: async (offered) => offered[0],
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
      name: 'safs_get_remote_workspace', arguments: { choose: true }
    });
    const routeValue = JSON.parse((route.content as any[])[0].text);
    const bindingId = routeValue.bindingId as string;
    assert.match(bindingId, /^[a-f0-9]{16}$/);
    assert.deepEqual(routeValue.workspace, {
      workspaceRoot: '/srv/a', host: 'dev'
    });
    assert.equal(routeValue.selectedInVsCode, true);
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
      name: 'safs_get_remote_workspace', arguments: { choose: true }
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

test('VS Code workspace picker binds an Agent, supports switching, and preserves bindings', async () => {
  const first = new AgentMcpServer(0, 'first', callbacks('first'));
  const second = new AgentMcpServer(0, 'second', callbacks('second'));
  let workspaces: DiscoveredAgentWorkspace[] = [];
  let selectedIndex: number | undefined = 1;
  const router = new AgentHttpRouter(await freePort(), 'router-token', {
    discover: () => workspaces,
    selectWorkspace: async (offered) => selectedIndex === undefined
      ? undefined
      : offered[selectedIndex]
  });
  const client = new Client({ name: 'workspace-picker-test', version: '1.0.0' });
  try {
    await Promise.all([first.start(), second.start()]);
    workspaces = [
      record('focused', first.url, {
        mountName: 'A', host: 'host-a', workspaceRoot: '/srv/a', focused: true
      }),
      record('other', second.url, {
        mountName: 'B', host: 'host-b', workspaceRoot: '/srv/b', focused: false
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

    const selected = await client.callTool({
      name: 'safs_get_remote_workspace', arguments: { choose: true }
    });
    const selectedValue = JSON.parse((selected.content as any[])[0].text);
    const bindingId = selectedValue.bindingId as string;
    assert.deepEqual(selectedValue.workspace, {
      workspaceRoot: '/srv/b', host: 'host-b'
    });
    assert.equal(selectedValue.selectedInVsCode, true);
    const bound = await client.callTool({
      name: 'remote_list', arguments: { bindingId, path: '.' }
    });
    assert.equal(JSON.parse((bound.content as any[])[0].text).label, 'second');

    selectedIndex = undefined;
    const cancelled = await client.callTool({
      name: 'safs_get_remote_workspace', arguments: { choose: true }
    });
    assert.equal(cancelled.isError, true);
    assert.equal(
      JSON.parse((cancelled.content as any[])[0].text).code,
      'WORKSPACE_SELECTION_CANCELLED'
    );
    const stillBound = await client.callTool({
      name: 'remote_list', arguments: { bindingId, path: '.' }
    });
    assert.equal(JSON.parse((stillBound.content as any[])[0].text).label, 'second');

    selectedIndex = 0;
    const switchedSelection = await client.callTool({
      name: 'safs_get_remote_workspace', arguments: { choose: true }
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
    discover: () => [record('self', `http://127.0.0.1:${port}/mcp?token=router-token`)],
    selectWorkspace: async (offered) => offered[0]
  });
  const client = new Client({ name: 'http-router-test', version: '1.0.0' });
  try {
    await router.start();
    await client.connect(new StreamableHTTPClientTransport(new URL(router.url)));
    const selected = await client.callTool({
      name: 'safs_get_remote_workspace', arguments: { choose: true }
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
