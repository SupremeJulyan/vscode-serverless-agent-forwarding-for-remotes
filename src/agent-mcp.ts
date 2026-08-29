import * as http from 'node:http';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  configureAgentMcpResources, directAgentMcpInstructions,
  registerAgentMcpTools
} from './agent-mcp-tools';

export interface RemoteFolderInfo {
  name: string;
  workspaceUri: string;
  workspaceRoot: string;
  host: string;
}

export interface AgentMcpCallbacks {
  listFolders(): Promise<RemoteFolderInfo[]>;
  currentWorkspace(): Promise<RemoteFolderInfo | null>;
  /** 当前打开的远程文件元数据（无活动远程文件时为 null）。 */
  currentFile(input: { mountName?: string }): Promise<unknown>;
  list(input: { mountName?: string; path?: string; limit?: number }): Promise<unknown>;
  write(input: { mountName?: string; path: string; content: string }): Promise<unknown>;
  search(input: {
    mountName?: string; query: string; path?: string; agentName?: string;
    agentPlatform?: string;
  }): Promise<unknown>;
  run(input: {
    command: string; mountName?: string; remoteCwd?: string; agentName?: string;
    agentPlatform?: string;
  }): Promise<unknown>;
  request?(agentName?: string, agentPlatform?: string): void;
  audit?(entry: {
    toolName: string; input: Record<string, unknown>;
    agentName?: string; agentPlatform?: string;
  }): void;
  log?(message: string): void;
}

export class AgentMcpServer {
  private httpServer: http.Server | undefined;
  private _portUnavailable = false;
  private listeningPort: number | undefined;

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly callbacks: AgentMcpCallbacks
  ) {}

  get url(): string {
    const port = this.listeningPort ?? this.port;
    return `http://127.0.0.1:${port}/mcp?token=${encodeURIComponent(this.token)}`;
  }

  get running(): boolean {
    return this.httpServer !== undefined;
  }

  get portUnavailable(): boolean {
    return this._portUnavailable;
  }

  private createProtocolServer(agentName?: string, agentPlatform?: string): McpServer {
    const server = new McpServer(
      { name: 'safs', version: '1.0.0' },
      { instructions: directAgentMcpInstructions }
    );
    configureAgentMcpResources(server);
    // 紧凑 JSON：结果只回传必要字段，缩进空白会白白消耗模型 token。
    const result = (value: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value) }]
    });
    // 业务错误作为 MCP tool result 返回，使固定路由器能原样透传；
    // 只有 HTTP/转发层故障才应被标记为 REMOTE_UNAVAILABLE。
    const toolError = (error: unknown) => ({
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({
        code: 'REMOTE_TOOL_ERROR',
        message: error instanceof Error ? error.message : String(error)
      }) }]
    });
    const invoke = async (callback: () => Promise<unknown>) => {
      try {
        return result(await callback());
      } catch (error) {
        return toolError(error);
      }
    };
    // name/workspaceUri 是内部路由标识，不对 Agent 暴露。
    const publicFolder = (info: RemoteFolderInfo) => ({
      workspaceRoot: info.workspaceRoot,
      host: info.host
    });
    registerAgentMcpTools(server, {
      routed: false,
      invoke: (name, input) => {
        switch (name) {
          case 'safs_get_remote_workspace':
            return invoke(async () => {
              const current = await this.callbacks.currentWorkspace();
              return current ? {
                workspace: publicFolder(current),
                localFilesystemAllowed: false,
                localShellAllowed: false
              } : { workspace: null };
            });
          case 'current_remote_file':
            return invoke(() => this.callbacks.currentFile(input));
          case 'remote_list':
            return invoke(() => this.callbacks.list(input));
          case 'remote_write':
            return invoke(() => this.callbacks.write(input as {
              mountName?: string; path: string; content: string;
            }));
          case 'remote_search':
            return invoke(() => this.callbacks.search({
              ...input, agentName, agentPlatform
            } as Parameters<AgentMcpCallbacks['search']>[0]));
          case 'run_remote_command':
            return invoke(() => this.callbacks.run({
              ...input, agentName, agentPlatform
            } as Parameters<AgentMcpCallbacks['run']>[0]));
        }
      }
    });
    return server;
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.all('/mcp', async (request, response) => {
      if (request.query.token !== this.token) {
        this.callbacks.log?.(`拒绝未授权 MCP 请求：${request.method}`);
        response.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (request.method !== 'POST') {
        this.callbacks.log?.(`拒绝不支持的 MCP 请求方法：${request.method}`);
        response.status(405).json({ error: 'Method not allowed' });
        return;
      }
      const agentName = typeof request.query.agent === 'string'
        ? request.query.agent.trim().slice(0, 100).replace(/[\u0000-\u001f\u007f]/g, '_')
        : undefined;
      const platformValue = request.query.platform;
      const agentPlatform = typeof platformValue === 'string'
        && ['wsl', 'mac', 'linux', 'win'].includes(platformValue)
        ? platformValue
        : undefined;
      const method = typeof request.body?.method === 'string' ? request.body.method : 'unknown';
      const tool = request.body?.params?.name;
      this.callbacks.log?.(`收到 MCP 请求：${method}${tool ? ` (${tool})` : ''}${
        agentName ? `，agent=${agentName}` : '，agent=<unknown>'
      }${agentPlatform ? `，platform=${agentPlatform}` : ''
      }`);
      this.callbacks.request?.(agentName, agentPlatform);
      if (method === 'tools/call' && typeof tool === 'string') {
        const input = request.body?.params?.arguments;
        this.callbacks.audit?.({
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
        this.callbacks.log?.(
          `MCP 请求失败：${error instanceof Error ? error.message : String(error)}`
        );
        if (!response.headersSent) {
          response.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
            id: null
          });
        }
      } finally {
        await transport.close();
        await protocol.close();
      }
    });
    const server = http.createServer(app);
    this._portUnavailable = false;
    await new Promise<void>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this._portUnavailable = true;
          this.callbacks.log?.(
            `MCP 端口 ${this.port} 已被其他窗口占用；请将 agentMcpPort 设为 0 以启用每窗口独立端口。`
          );
          resolve();
        } else {
          reject(err);
        }
      });
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (address && typeof address !== 'string') this.listeningPort = address.port;
        resolve();
      });
    });
    if (this._portUnavailable) {
      // A fixed port can collide with another window. Do not claim that the
      // other server represents this window; no cross-window reuse is safe.
      return;
    }
    this.httpServer = server;
    this.callbacks.log?.(
      `MCP 已启动：http://127.0.0.1:${this.listeningPort ?? this.port}/mcp?token=<hidden>`
    );
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = undefined;
    this.listeningPort = undefined;
    if (!server) return;
    this.callbacks.log?.('正在停止 MCP');
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    this.callbacks.log?.('MCP 已停止');
  }
}
