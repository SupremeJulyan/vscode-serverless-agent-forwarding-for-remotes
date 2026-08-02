const readline = require('node:readline');
const { readBinding, workspaceForBinding } = require('./discovery.cjs');

const tools = [
  ['resolve_workspace_execution', 'Resolve workspace execution route', 'Resolve the Serverless Remote workspace bound to this Codex conversation.', {}],
  ['list_remote_folders', 'List SFTP remote folders', 'Lists the remote folder bound to this Codex conversation.', {}],
  ['current_remote_workspace', 'Get current remote workspace', 'Returns the remote folder bound to this Codex conversation.', {}],
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
    properties: {
      ...properties,
      _sessionId: {
        type: 'string',
        description: 'Internal Codex session routing value injected by the plugin hook.'
      }
    },
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
  const sessionId = args._sessionId;
  delete args._sessionId;
  if (!sessionId) {
    return toolError(
      'SESSION_NOT_BOUND',
      'The Codex session routing hook did not provide a session id. Review and trust the Serverless Remote plugin hooks, then retry.'
    );
  }
  const binding = readBinding(sessionId);
  if (!binding) {
    return toolError(
      'SESSION_NOT_BOUND',
      'This Codex conversation is not bound to a Serverless Remote workspace. Focus a connected remote window and start or resume the conversation.'
    );
  }
  const workspace = workspaceForBinding(binding);
  if (!workspace) {
    return toolError(
      'REMOTE_DISCONNECTED',
      `Serverless Remote mount ${binding.mountName} is disconnected. Reconnect the same mount in VS Code and retry in this conversation.`,
      { mountName: binding.mountName }
    );
  }
  if (args.mountName && args.mountName !== binding.mountName) {
    return toolError(
      'MOUNT_MISMATCH',
      `This conversation is bound to ${binding.mountName}, not ${args.mountName}.`,
      { mountName: binding.mountName }
    );
  }
  args.mountName = binding.mountName;
  try {
    return await forward(workspace, name, args, request.id);
  } catch (error) {
    return toolError(
      'REMOTE_UNAVAILABLE',
      `Serverless Remote mount ${binding.mountName} is currently unavailable: ${error.message}`,
      { mountName: binding.mountName }
    );
  }
}

async function handle(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return;
  if (request.method.startsWith('notifications/')) return;
  if (request.method === 'initialize') {
    return {
      protocolVersion: request.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'serverless-remote-router', version: '0.1.0' },
      instructions: 'Routes each Codex conversation to its bound Serverless Remote SSH window. Calls survive window disconnects and dynamic-port changes.'
    };
  }
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') return { tools };
  if (request.method === 'tools/call') return callTool(request);
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
