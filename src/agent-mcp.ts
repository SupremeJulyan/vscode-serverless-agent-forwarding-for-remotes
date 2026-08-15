import * as http from 'node:http';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListResourcesRequestSchema, ListResourceTemplatesRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export interface RemoteFolderInfo {
  name: string;
  workspaceUri: string;
  remoteRoot: string;
  host: string;
}

export interface AgentMcpCallbacks {
  listFolders(): Promise<RemoteFolderInfo[]>;
  currentWorkspace(): Promise<RemoteFolderInfo | null>;
  /** 当前打开的远程文件元数据（无活动远程文件时为 null）。 */
  currentFile(input: { mountName?: string }): Promise<unknown>;
  list(input: { mountName?: string; path?: string }): Promise<unknown>;
  write(input: { mountName?: string; path: string; content: string }): Promise<unknown>;
  search(input: { mountName?: string; query: string; path?: string }): Promise<unknown>;
  run(input: { command: string; mountName?: string; remoteCwd?: string }): Promise<unknown>;
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

  private createProtocolServer(): McpServer {
    const server = new McpServer(
      { name: 'safs', version: '1.0.0' },
      {
        instructions:
          'This VS Code workspace may use the safs virtual filesystem. Virtual remote files are NOT present in the agent host filesystem. '
          + 'At the start of every conversation, call resolve_workspace_execution before reading files, running shell commands, inferring the OS, or using Git/build/test/package tools. '
          + 'When it returns execution="remote", use only remote_list, remote_write, remote_search, current_remote_file, and run_remote_command for workspace operations. Never substitute the local filesystem or local shell. '
          + 'File content is never returned into the conversation; inspect files with run_remote_command (head, sed, grep, tail, wc, diff) on the remote host instead. '
          + 'To learn which file is open in the VS Code window, call current_remote_file for its path and metadata. '
          + 'mountName may be omitted to target the active forwarded remote workspace.'
      }
    );
    server.server.registerCapabilities({ resources: {} });
    server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
    server.server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async () => ({ resourceTemplates: [] })
    );
    const result = (value: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
    });
    server.registerTool(
      'resolve_workspace_execution',
      {
        title: 'Resolve workspace execution route',
        description:
          'MANDATORY first step. Detects the active SFTP workspace and returns its remote root, mountName, and tool routing.',
        _meta: { 'anthropic/alwaysLoad': true },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        inputSchema: {}
      },
      async () => {
        const workspace = await this.callbacks.currentWorkspace();
        return result(workspace ? {
          execution: 'remote',
          workspace,
          fileTools: ['remote_list', 'remote_write', 'remote_search', 'current_remote_file'],
          commandTool: 'run_remote_command',
          localFilesystemAllowed: false,
          localShellAllowed: false
        } : {
          execution: 'local',
          workspace: null
        });
      }
    );
    server.registerTool(
      'list_remote_folders',
      {
        title: 'List SFTP remote folders',
        description: 'Lists active Agent-forwarded remote folders.',
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        inputSchema: {}
      },
      async () => result(await this.callbacks.listFolders())
    );
    server.registerTool(
      'current_remote_file',
      {
        title: 'Get the currently open remote file',
        description:
          'Returns the remote file open in the active VS Code editor of this window: absolute path, relative path, name, size, and dirty (unsaved changes). null when none is open.',
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        inputSchema: {
          mountName: z.string().min(1).optional()
        }
      },
      async (input) => result(await this.callbacks.currentFile(input))
    );
    server.registerTool(
      'remote_list',
      {
        title: 'List a remote directory',
        description: 'Lists files directly over SFTP. Paths are relative to the remote root.',
        inputSchema: {
          mountName: z.string().min(1).optional(),
          path: z.string().optional()
        }
      },
      async (input) => result(await this.callbacks.list(input))
    );
    server.registerTool(
      'remote_write',
      {
        title: 'Write a remote file',
        description: 'Creates or replaces a UTF-8 file directly over SFTP.',
        annotations: { destructiveHint: true },
        inputSchema: {
          mountName: z.string().min(1).optional(),
          path: z.string(),
          content: z.string()
        }
      },
      async (input) => result(await this.callbacks.write(input))
    );
    server.registerTool(
      'remote_search',
      {
        title: 'Search remote files',
        description: 'Searches file contents on the remote SSH host.',
        inputSchema: {
          mountName: z.string().min(1).optional(),
          query: z.string().min(1),
          path: z.string().optional()
        }
      },
      async (input) => result(await this.callbacks.search(input))
    );
    server.registerTool(
      'run_remote_command',
      {
        title: 'Run a remote SSH command',
        description: 'Runs a shell command on the selected SSH host.',
        annotations: { destructiveHint: true, openWorldHint: true },
        inputSchema: {
          mountName: z.string().min(1).optional(),
          command: z.string().min(1),
          remoteCwd: z.string().optional()
        }
      },
      async (input) => result(await this.callbacks.run(input))
    );
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
      const method = typeof request.body?.method === 'string' ? request.body.method : 'unknown';
      const tool = request.body?.params?.name;
      this.callbacks.log?.(`收到 MCP 请求：${method}${tool ? ` (${tool})` : ''}`);
      const protocol = this.createProtocolServer();
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
