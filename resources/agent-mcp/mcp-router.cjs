const readline = require('node:readline');
const { activeWorkspace, allWorkspaces, workspaceForMount } = require('./discovery.cjs');

function trace(message) {
  process.stderr.write(`[Serverless Remote][MCP Router] ${message}\n`);
}

const tools = [
  ['resolve_workspace_execution', 'Resolve workspace execution route', 'Resolve the active Serverless Remote workspace. Call this before any workspace operation.', {}],
  ['list_remote_folders', 'List SFTP remote folders', 'Lists active Agent-forwarded remote folders.', {}],
  ['current_remote_workspace', 'Get current remote workspace', 'Returns the focused active remote folder.', {}],
  ['remote_list', 'List a remote directory', 'Lists files directly over SFTP.', {
    path: { type: 'string' }, mountName: { type: 'string' }
  }],
  ['remote_read', 'Read a remote file', 'Reads a UTF-8 file directly over SFTP.', {
    path: { type: 'string' }, offset: { type: 'number' }, length: { type: 'number' },
    mountName: { type: 'string' }
  }, ['path']],
  ['remote_write', 'Write a remote file', 'Creates or replaces a UTF-8 file over SFTP.', {
    path: { type: 'string' }, content: { type: 'string' }, mountName: { type: 'string' }
  }, ['path', 'content']],
  ['remote_search', 'Search remote files', 'Searches file contents on the remote SSH host.', {
    query: { type: 'string' }, path: { type: 'string' }, mountName: { type: 'string' }
  }, ['query']],
  ['run_remote_command', 'Run a remote SSH command', 'Runs a command on the bound SSH host.', {
    command: { type: 'string' }, remoteCwd: { type: 'string' }, mountName: { type: 'string' }
  }, ['command']]
].map(([name, title, description, properties, required = []]) => ({
  name,
  title,
  description,
  inputSchema: {
    type: 'object',
    properties,
    required
  },
  annotations: {
    readOnlyHint: !['remote_write', 'run_remote_command'].includes(name),
    destructiveHint: ['remote_write', 'run_remote_command'].includes(name),
    openWorldHint: name === 'run_remote_command'
  }
}));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolError(code, message, details = {}) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message, ...details }, null, 2) }]
  };
}

function parseSse(text, requestId) {
  const messages = text.split(/\r?\n\r?\n/).flatMap((event) => {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data) return [];
    try { return [JSON.parse(data)]; } catch { return []; }
  });
  return messages.find((message) => message.id === requestId) || messages.at(-1);
}

async function forward(workspace, name, args, requestId) {
  const url = new URL(workspace.mcpUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('Refusing to forward to a non-loopback MCP endpoint');
  }
  const downstreamId = `router-${process.pid}-${Date.now()}-${requestId}`;
  trace(`转发工具 ${name} 到 mount=${workspace.mountName}，port=${url.port}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: downstreamId, method: 'tools/call',
      params: { name, arguments: args }
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Window MCP returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  const downstream = response.headers.get('content-type')?.includes('text/event-stream')
    ? parseSse(body, downstreamId)
    : JSON.parse(body);
  if (!downstream) throw new Error('Window MCP returned no JSON-RPC response');
  if (downstream.error) throw new Error(downstream.error.message || 'Window MCP request failed');
  return downstream.result;
}

async function callTool(request) {
  const name = request.params?.name;
  const args = { ...(request.params?.arguments || {}) };
  if (name === 'list_remote_folders') {
    const folders = allWorkspaces().map(({ mcpUrl, discoveryFile, updatedAtMs, ...workspace }) => workspace);
    trace(`列出 ${folders.length} 个活动远程工作区`);
    return { content: [{ type: 'text', text: JSON.stringify(folders, null, 2) }] };
  }
  const workspace = args.mountName
    ? workspaceForMount(args.mountName)
    : activeWorkspace();
  if (!workspace) {
    trace(`拒绝工具 ${name || '<unknown>'}：没有匹配的活动远程窗口`);
    return toolError(
      'NO_ACTIVE_REMOTE',
      args.mountName
        ? `Serverless Remote mount ${args.mountName} is not active. Enable Agent forwarding and open that remote folder in VS Code.`
        : 'No active Agent-forwarded Serverless Remote window was found. Focus an enabled remote window and retry.',
      args.mountName ? { mountName: args.mountName } : {}
    );
  }
  args.mountName = workspace.mountName;
  try {
    const result = await forward(workspace, name, args, request.id);
    trace(`工具 ${name} 完成，mount=${workspace.mountName}`);
    return result;
  } catch (error) {
    trace(`工具 ${name || '<unknown>'} 失败，mount=${workspace.mountName}：${error.message}`);
    return toolError(
      'REMOTE_UNAVAILABLE',
      `Serverless Remote mount ${workspace.mountName} is currently unavailable: ${error.message}`,
      { mountName: workspace.mountName }
    );
  }
}

async function handle(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return;
  if (request.method.startsWith('notifications/')) return;
  if (request.method === 'initialize') {
    trace('Codex 已初始化固定 MCP 路由器');
    return {
      protocolVersion: request.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'serverless-remote-router', version: '0.1.0' },
      instructions: [
        'This MCP server is the complete integration for Serverless Remote SSH virtual workspaces.',
        'Before reading files, editing, searching, running shell commands, using Git, builds, tests, or inferring the OS, call resolve_workspace_execution.',
        'When it returns execution="remote", use only remote_list, remote_read, remote_write, remote_search, and run_remote_command for that workspace.',
        'Never use local shell or local filesystem tools for a serverless-sftp workspace because its files do not exist locally.',
        'Omit mountName to use the currently focused Agent-forwarded VS Code window, or pass mountName explicitly to select an active forwarded mount.'
      ].join(' ')
    };
  }
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') return { tools };
  if (request.method === 'tools/call') {
    trace(`收到工具调用 ${request.params?.name || '<unknown>'}`);
    return callTool(request);
  }
  throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
    const result = await handle(request);
    if (request.id !== undefined && result !== undefined) {
      send({ jsonrpc: '2.0', id: request.id, result });
    }
  } catch (error) {
    if (request?.id !== undefined) {
      send({
        jsonrpc: '2.0', id: request.id,
        error: { code: error.code || -32603, message: error.message || String(error) }
      });
    } else {
      process.stderr.write(`Serverless Remote MCP router error: ${error.message || error}\n`);
    }
  }
});
