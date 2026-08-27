import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListResourcesRequestSchema, ListResourceTemplatesRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  DiscoveredAgentWorkspace, agentDiscoveryDirectories, discoverAgentWorkspaces
} from './agent-discovery';

const routerIdentity = 'safs-http-router-v1';

/** 为共用 MCP 地址附加可观测的 Agent 来源标签（不作为身份认证）。 */
export type AgentPlatformLabel = 'wsl' | 'mac' | 'linux' | 'win';

export function agentTaggedMcpUrl(
  routerUrl: string, agentName: string, platform?: AgentPlatformLabel
): string {
  const normalized = agentName.trim();
  if (!normalized) throw new Error('Agent name must not be empty');
  if (normalized.length > 100) throw new Error('Agent name must not exceed 100 characters');
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('Agent name must not contain control characters');
  }
  const url = new URL(routerUrl);
  url.searchParams.set('agent', normalized);
  if (platform) url.searchParams.set('platform', platform);
  return url.toString();
}

export interface AgentHttpRouterOptions {
  discover?: () => DiscoveredAgentWorkspace[];
  selectWorkspace?: (
    workspaces: DiscoveredAgentWorkspace[]
  ) => Promise<DiscoveredAgentWorkspace | undefined>;
  log?: (message: string) => void;
  /** 转发到窗口 MCP 的 fetch 超时（毫秒），缺省 120s。 */
  forwardTimeoutMs?: number;
  audit?: (entry: {
    toolName: string; input: Record<string, unknown>;
    agentName?: string; agentPlatform?: AgentPlatformLabel;
  }) => void;
}

export class AgentHttpRouter {
  private httpServer: http.Server | undefined;
  private _available = false;
  private _leader = false;
  private readonly discover: () => DiscoveredAgentWorkspace[];
  private readonly bindings = new Map<string, {
    host: string; workspaceRoot: string; owner: string;
  }>();

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly options: AgentHttpRouterOptions = {}
  ) {
    if (options.discover) {
      this.discover = options.discover;
    } else {
      const directories = agentDiscoveryDirectories();
      this.discover = () => discoverAgentWorkspaces(directories);
    }
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp?token=${encodeURIComponent(this.token)}`;
  }

  get available(): boolean {
    return this._available;
  }

  get leader(): boolean {
    return this._leader;
  }

  private workspaces(): DiscoveredAgentWorkspace[] {
    return this.discover();
  }

  private bindingKey(agentName?: string, agentPlatform?: AgentPlatformLabel): string {
    return `${agentName ?? '<unknown>'}\0${agentPlatform ?? '<unknown>'}`;
  }

  private workspace(bindingId: string): DiscoveredAgentWorkspace | undefined {
    const workspaces = this.workspaces();
    const binding = this.bindings.get(bindingId);
    return binding && workspaces.find((workspace) =>
      workspace.host === binding.host && workspace.workspaceRoot === binding.workspaceRoot
    );
  }

  private publicWorkspace(workspace: DiscoveredAgentWorkspace): Record<string, unknown> {
    return {
      workspaceRoot: workspace.workspaceRoot,
      host: workspace.host
    };
  }

  private toolError(code: string, message: string, details: Record<string, unknown> = {}) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({
        code, message, ...details
      }) }]
    };
  }

  private parseSse(text: string, requestId: string): unknown {
    const messages = text.split(/\r?\n\r?\n/).flatMap((event) => {
      const data = event.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data) return [];
      try {
        return [JSON.parse(data) as { id?: unknown }];
      } catch {
        return [];
      }
    });
    return messages.find((message) => message.id === requestId) ?? messages.at(-1);
  }

  private async forward(
    workspace: DiscoveredAgentWorkspace, name: string, args: Record<string, unknown>,
    agentName?: string, agentPlatform?: AgentPlatformLabel
  ): Promise<any> {
    const url = new URL(workspace.mcpUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      throw new Error('Refusing to forward to a non-loopback MCP endpoint');
    }
    // 拒绝转发到路由器自身端口：伪造/损坏的发现记录若指向本路由器，会无限递归。
    if (url.port === String(this.port)) {
      throw new Error('Refusing to forward to the router itself');
    }
    if (agentName) url.searchParams.set('agent', agentName);
    if (agentPlatform) url.searchParams.set('platform', agentPlatform);
    const requestId = `http-router-${process.pid}-${Date.now()}-${randomUUID()}`;
    this.options.log?.(
      `转发工具 ${name} 到 mount=${workspace.mountName}，port=${url.port}${
        agentName ? `，agent=${agentName}` : ''
      }`
    );
    const response = await fetch(url, {
      method: 'POST',
      // redirect: manual —— 不允许 3xx 重定向跳出 loopback（SSRF 防护）。
      redirect: 'manual',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        // 标记这是路由器发起的转发；目标若是另一个路由器会拒绝（防路由器间环）。
        'x-safs-forwarded': '1'
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: requestId, method: 'tools/call',
        params: { name, arguments: args }
      }),
      signal: AbortSignal.timeout(this.options.forwardTimeoutMs ?? 120_000)
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Window MCP returned HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    const downstream = (response.headers.get('content-type')?.includes('text/event-stream')
      ? this.parseSse(body, requestId)
      : JSON.parse(body)) as { result?: unknown; error?: { message?: string } } | undefined;
    if (!downstream) throw new Error('Window MCP returned no JSON-RPC response');
    if (downstream.error) {
      throw new Error(downstream.error.message || 'Window MCP request failed');
    }
    return downstream.result;
  }

  private async callTool(
    name: string, input: Record<string, unknown>, agentName?: string,
    agentPlatform?: AgentPlatformLabel
  ): Promise<any> {
    if (name === 'safs_get_remote_workspace') {
      const workspaces = this.workspaces();
      if (!workspaces.length) {
        return this.toolError(
          'NO_ACTIVE_REMOTE',
          'No active Agent-forwarded Serverless Remote window was found.'
        );
      }
      const workspace = this.options.selectWorkspace
        ? await this.options.selectWorkspace(workspaces)
        : workspaces[0];
      if (!workspace) {
        return this.toolError(
          'WORKSPACE_SELECTION_CANCELLED',
          'Remote workspace selection was cancelled in VS Code.'
        );
      }
      const bindingId = randomUUID().replace(/-/g, '').slice(0, 16);
      this.bindings.set(bindingId, {
        host: workspace.host,
        workspaceRoot: workspace.workspaceRoot,
        owner: this.bindingKey(agentName, agentPlatform)
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          workspace: this.publicWorkspace(workspace),
          bindingId,
          selectedInVsCode: true,
          localFilesystemAllowed: false,
          localShellAllowed: false
        }) }]
      };
    }
    const bindingId = typeof input.bindingId === 'string' ? input.bindingId : '';
    if (!bindingId) {
      return this.toolError(
        'WORKSPACE_BINDING_REQUIRED',
        'Call safs_get_remote_workspace first and ask the user to complete the Quick Pick in VS Code, then pass the returned bindingId.'
      );
    }
    const binding = this.bindings.get(bindingId);
    if (!binding || binding.owner !== this.bindingKey(agentName, agentPlatform)) {
      return this.toolError(
        'WORKSPACE_BINDING_INVALID',
        'The workspace binding is invalid for this Agent session. Select the workspace again.'
      );
    }
    const workspace = this.workspace(bindingId);
    if (!workspace) {
      this.bindings.delete(bindingId);
      return this.toolError(
        'WORKSPACE_BINDING_EXPIRED',
        'The selected remote workspace is no longer active. Ask the user to choose again in VS Code.',
        { host: binding.host, workspaceRoot: binding.workspaceRoot }
      );
    }
    const { bindingId: _bindingId, ...publicInput } = input;
    const args = { ...publicInput, mountName: workspace.mountName };
    try {
      return await this.forward(workspace, name, args, agentName, agentPlatform);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.options.log?.(`工具 ${name} 失败，mount=${workspace.mountName}：${detail}`);
      return this.toolError(
        'REMOTE_UNAVAILABLE',
        `Serverless Remote mount ${workspace.mountName} is currently unavailable: ${detail}`,
        { mountName: workspace.mountName }
      );
    }
  }

  private createProtocolServer(
    agentName?: string, agentPlatform?: AgentPlatformLabel
  ): McpServer {
    const server = new McpServer(
      { name: 'safs-http-router', version: '1.0.0' },
      {
        instructions: [
          'This MCP server is only for SAFS remote workspaces; do not call SAFS tools for ordinary local workspaces.',
          'Only for an explicit SAFS task or known safs:// context, tell the user to choose the remote workspace in the VS Code Quick Pick, then call safs_get_remote_workspace. The choice and confirmation happen only in VS Code, never in the Agent conversation.',
          'Call safs_get_remote_workspace again whenever the user wants to switch to another remote workspace or a binding expires.',
          'Use the returned workspace and its remote_list, remote_write, remote_search, current_remote_file, and run_remote_command tools for that workspace.',
          'File content is never returned into the conversation; inspect files with run_remote_command (head, sed, grep, tail, wc, diff) on the remote host instead.',
          'To learn which file is open in the VS Code window, call current_remote_file for its path and metadata.',
          'Never use local shell or local filesystem tools for a safs workspace because its files do not exist locally.',
          'Pass the bindingId returned by safs_get_remote_workspace to every later workspace tool call. If it expires, ask the user to choose again in VS Code; never guess or silently switch workspaces.'
        ].join(' ')
      }
    );
    server.server.registerCapabilities({ resources: {} });
    server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
    server.server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async () => ({ resourceTemplates: [] })
    );
    const register = (
      name: string, title: string, description: string,
      inputSchema: Record<string, z.ZodTypeAny>,
      annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean }
    ) => server.registerTool(
      name,
      { title, description, inputSchema, annotations },
      async (input) => this.callTool(
        name, (input ?? {}) as Record<string, unknown>, agentName, agentPlatform
      )
    );
    register(
      'safs_get_remote_workspace', 'Choose a SAFS remote workspace in VS Code',
      'Opens a VS Code Quick Pick for the user to choose and confirm the remote workspace, then returns a bindingId. Before calling, tell the user to complete the selection in VS Code. Do not ask them to choose in the Agent conversation.',
      {}, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    );
    register(
      'current_remote_file', 'Get the currently open remote file',
      'Returns the remote file open in the active VS Code editor of the bound window (absolute path, relative path, size, dirty), or null when none is open.',
      { bindingId: z.string().min(1) },
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    );
    register(
      'remote_list', 'List a remote directory',
      'Lists files directly over SFTP. Relative paths start at the current VS Code workspace root. Entries are capped at 500 (raise limit if needed); large directories return truncated with total.',
      {
        bindingId: z.string().min(1), path: z.string().optional(),
        limit: z.number().int().min(1).max(10000).optional()
      },
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    );
    register(
      'remote_write', 'Write a remote file', 'Creates or replaces a UTF-8 file over SFTP.',
      { bindingId: z.string().min(1), path: z.string().min(1), content: z.string() },
      { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    );
    register(
      'remote_search', 'Search remote files',
      'Searches file contents on the remote SSH host. Relative paths start at the current VS Code workspace root. Results are capped (200 matches, lines trimmed to 300 chars).',
      {
        bindingId: z.string().min(1), query: z.string().min(1), path: z.string().optional()
      },
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    );
    register(
      'run_remote_command', 'Run a remote SSH command',
      'Runs a command on the bound SSH host. The default working directory is the current VS Code workspace root.',
      {
        bindingId: z.string().min(1), command: z.string().min(1),
        remoteCwd: z.string().optional()
      },
      { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    );
    return server;
  }

  private async isExistingRouter(): Promise<boolean> {
    try {
      const response = await fetch(
        `http://127.0.0.1:${this.port}/health?token=${encodeURIComponent(this.token)}`,
        { signal: AbortSignal.timeout(1500) }
      );
      if (!response.ok) return false;
      const value = await response.json() as { identity?: unknown };
      return value.identity === routerIdentity;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.get('/health', (request, response) => {
      if (request.query.token !== this.token) {
        response.status(401).json({ error: 'Unauthorized' });
        return;
      }
      response.json({ identity: routerIdentity, leaderProcessId: process.pid });
    });
    app.all('/mcp', async (request, response) => {
      if (request.query.token !== this.token) {
        response.status(401).json({ error: 'Unauthorized' });
        return;
      }
      // 路由器绝不能作为另一个路由器的转发目标：带 x-safs-forwarded 标记的请求
      // 说明来源是路由器转发，直接拒绝，防止路由器间形成转发环。
      if (request.headers['x-safs-forwarded']) {
        this.options.log?.('拒绝路由器转发请求（x-safs-forwarded）');
        response.status(403).json({ error: 'Forwarding target must not be another router' });
        return;
      }
      if (request.method !== 'POST') {
        response.status(405).json({ error: 'Method not allowed' });
        return;
      }
      const agentName = typeof request.query.agent === 'string'
        ? request.query.agent.trim().slice(0, 100).replace(/[\u0000-\u001f\u007f]/g, '_')
        : undefined;
      const platformValue = request.query.platform;
      const agentPlatform = typeof platformValue === 'string'
        && ['wsl', 'mac', 'linux', 'win'].includes(platformValue)
        ? platformValue as AgentPlatformLabel
        : undefined;
      const method = typeof request.body?.method === 'string' ? request.body.method : 'unknown';
      const tool = request.body?.params?.name;
      this.options.log?.(
        `收到 MCP 请求：${method}${tool ? ` (${tool})` : ''}${
          agentName ? `，agent=${agentName}` : '，agent=<unknown>'
        }${agentPlatform ? `，platform=${agentPlatform}` : ''
        }`
      );
      // 工作区选择由固定路由器本地完成；其它工具只在实际执行窗口记录，避免双份日志。
      if (method === 'tools/call' && typeof tool === 'string'
        && tool === 'safs_get_remote_workspace') {
        const input = request.body?.params?.arguments;
        this.options.audit?.({
          toolName: tool,
          input: input && typeof input === 'object' ? input as Record<string, unknown> : {},
          agentName, agentPlatform
        });
      }
      const protocol = this.createProtocolServer(agentName, agentPlatform);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await protocol.connect(transport);
        await transport.handleRequest(request, response, request.body);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.options.log?.(`固定 HTTP MCP 请求失败：${detail}`);
        if (!response.headersSent) {
          response.status(500).json({
            jsonrpc: '2.0', error: { code: -32603, message: detail }, id: null
          });
        }
      } finally {
        await transport.close();
        await protocol.close();
      }
    });
    const candidate = http.createServer(app);
    const outcome = await new Promise<'leader' | 'occupied'>((resolve, reject) => {
      const startupError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') resolve('occupied');
        else reject(error);
      };
      candidate.once('error', startupError);
      candidate.listen(this.port, '127.0.0.1', () => {
        candidate.off('error', startupError);
        resolve('leader');
      });
    });
    if (outcome === 'leader') {
      candidate.on('error', (error) => {
        this.options.log?.(`固定 HTTP MCP 服务错误：${error.message}`);
      });
      this.httpServer = candidate;
      this._leader = true;
      this._available = true;
      this.options.log?.(`固定 HTTP MCP 路由器已接管端口 ${this.port}`);
      return;
    }
    this._leader = false;
    this._available = await this.isExistingRouter();
    if (!this._available) {
      throw new Error(
        `固定 HTTP MCP 端口 ${this.port} 已被其他程序占用；请修改 safs.agentHttpRouterPort。`
      );
    }
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = undefined;
    this._leader = false;
    this._available = false;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
