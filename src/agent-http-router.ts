import * as http from 'node:http';
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

export interface AgentHttpRouterOptions {
  discover?: () => DiscoveredAgentWorkspace[];
  log?: (message: string) => void;
}

export class AgentHttpRouter {
  private httpServer: http.Server | undefined;
  private _available = false;
  private _leader = false;
  private readonly discover: () => DiscoveredAgentWorkspace[];

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

  private workspace(mountName?: string): DiscoveredAgentWorkspace | undefined {
    const workspaces = this.workspaces();
    return mountName
      ? workspaces.find((workspace) => workspace.mountName === mountName)
      : workspaces[0];
  }

  private publicWorkspace(workspace: DiscoveredAgentWorkspace): Record<string, unknown> {
    return {
      name: workspace.mountName,
      execution: workspace.execution,
      workspaceUri: workspace.workspaceUri,
      mountName: workspace.mountName,
      remoteRoot: workspace.remoteRoot,
      host: workspace.host,
      focused: workspace.focused
    };
  }

  private toolError(code: string, message: string, details: Record<string, unknown> = {}) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({
        code, message, ...details
      }, null, 2) }]
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
    workspace: DiscoveredAgentWorkspace, name: string, args: Record<string, unknown>
  ): Promise<any> {
    const url = new URL(workspace.mcpUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      throw new Error('Refusing to forward to a non-loopback MCP endpoint');
    }
    const requestId = `http-router-${process.pid}-${Date.now()}-${Math.random()}`;
    this.options.log?.(
      `转发工具 ${name} 到 mount=${workspace.mountName}，port=${url.port}`
    );
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: requestId, method: 'tools/call',
        params: { name, arguments: args }
      }),
      signal: AbortSignal.timeout(120_000)
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

  private async callTool(name: string, input: Record<string, unknown>): Promise<any> {
    if (name === 'list_remote_folders') {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(this.workspaces().map((workspace) =>
            this.publicWorkspace(workspace)), null, 2)
        }]
      };
    }
    const requestedMount = typeof input.mountName === 'string' ? input.mountName : undefined;
    const workspace = this.workspace(requestedMount);
    if (!workspace) {
      return this.toolError(
        'NO_ACTIVE_REMOTE',
        requestedMount
          ? `Serverless Remote mount ${requestedMount} is not active. Enable Agent forwarding and open that remote folder in VS Code.`
          : 'No active Agent-forwarded Serverless Remote window was found. Focus an enabled remote window and retry.',
        requestedMount ? { mountName: requestedMount } : {}
      );
    }
    if (name === 'resolve_workspace_execution') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          execution: 'remote',
          workspace: this.publicWorkspace(workspace),
          fileTools: ['remote_list', 'remote_read', 'remote_write', 'remote_search'],
          commandTool: 'run_remote_command',
          localFilesystemAllowed: false,
          localShellAllowed: false
        }, null, 2) }]
      };
    }
    if (name === 'current_remote_workspace') {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(this.publicWorkspace(workspace), null, 2)
        }]
      };
    }
    const args = { ...input, mountName: workspace.mountName };
    try {
      return await this.forward(workspace, name, args);
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

  private createProtocolServer(): McpServer {
    const server = new McpServer(
      { name: 'safs-http-router', version: '1.0.0' },
      {
        instructions: [
          'This MCP server is the complete integration for SAFS virtual workspaces.',
          'Before reading files, editing, searching, running shell commands, using Git, builds, tests, or inferring the OS, call resolve_workspace_execution.',
          'When it returns execution="remote", use only remote_list, remote_read, remote_write, remote_search, and run_remote_command for that workspace.',
          'Never use local shell or local filesystem tools for a safs workspace because its files do not exist locally.',
          'Reuse the mountName returned by resolve_workspace_execution for every later tool call so background work stays bound to the same remote window.'
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
      async (input) => this.callTool(name, input as Record<string, unknown>)
    );
    register(
      'resolve_workspace_execution', 'Resolve workspace execution route',
      'Resolve the active Serverless Remote workspace. Call this before any workspace operation.',
      {}, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    );
    register(
      'list_remote_folders', 'List SFTP remote folders',
      'Lists active Agent-forwarded remote folders.',
      {}, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    );
    register(
      'current_remote_workspace', 'Get current remote workspace',
      'Returns the focused active remote folder.',
      { mountName: z.string().min(1).optional() },
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    );
    register(
      'remote_list', 'List a remote directory', 'Lists files directly over SFTP.',
      { path: z.string().optional(), mountName: z.string().min(1).optional() },
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    );
    register(
      'remote_read', 'Read a remote file', 'Reads a UTF-8 file directly over SFTP.',
      {
        path: z.string(), offset: z.number().int().min(0).optional(),
        length: z.number().int().min(1).max(1_048_576).optional(),
        mountName: z.string().min(1).optional()
      },
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    );
    register(
      'remote_write', 'Write a remote file', 'Creates or replaces a UTF-8 file over SFTP.',
      { path: z.string(), content: z.string(), mountName: z.string().min(1).optional() },
      { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    );
    register(
      'remote_search', 'Search remote files', 'Searches file contents on the remote SSH host.',
      {
        query: z.string().min(1), path: z.string().optional(),
        mountName: z.string().min(1).optional()
      },
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    );
    register(
      'run_remote_command', 'Run a remote SSH command',
      'Runs a command on the bound SSH host.',
      {
        command: z.string().min(1), remoteCwd: z.string().optional(),
        mountName: z.string().min(1).optional()
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
      if (request.method !== 'POST') {
        response.status(405).json({ error: 'Method not allowed' });
        return;
      }
      const protocol = this.createProtocolServer();
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
