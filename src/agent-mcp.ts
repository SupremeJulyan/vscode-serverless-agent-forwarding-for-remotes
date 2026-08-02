import * as http from 'node:http';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface RemoteFolderInfo {
  name: string;
  workspaceUri: string;
  remoteRoot: string;
  host: string;
  remoteInstructions?: string;
}

export interface AgentMcpCallbacks {
  listFolders(): Promise<RemoteFolderInfo[]>;
  currentWorkspace(): Promise<RemoteFolderInfo | null>;
  list(input: { mountName?: string; path?: string }): Promise<unknown>;
  read(input: { mountName?: string; path: string; offset?: number; length?: number }): Promise<unknown>;
  write(input: { mountName?: string; path: string; content: string }): Promise<unknown>;
  search(input: { mountName?: string; query: string; path?: string }): Promise<unknown>;
  run(input: { command: string; mountName?: string; remoteCwd?: string }): Promise<unknown>;
  log?(message: string): void;
}

export class AgentMcpServer {
  private httpServer: http.Server | undefined;
  private _portUnavailable = false;

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly callbacks: AgentMcpCallbacks
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp?token=${encodeURIComponent(this.token)}`;
  }

  get running(): boolean {
    return this.httpServer !== undefined;
  }

  get portUnavailable(): boolean {
    return this._portUnavailable;
  }

  private createProtocolServer(): McpServer {
    const server = new McpServer(
      { name: 'serverless-remote-ssh', version: '2.0.0' },
      {
        instructions:
          'This VS Code workspace may use the serverless-sftp virtual filesystem. Virtual remote files are NOT present in the agent host filesystem. '
          + 'At the start of every conversation, call resolve_workspace_execution before reading files, running shell commands, inferring the OS, or using Git/build/test/package tools. '
          + 'When it returns execution="remote", use only remote_list, remote_read, remote_write, remote_search, and run_remote_command for workspace operations. Never substitute the local filesystem or local shell. '
          + 'mountName may be omitted to target the active forwarded remote workspace. Project instructions returned as remoteInstructions apply to the remote workspace.'
      }
    );
    const result = (value: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
    });
    server.registerTool(
      'resolve_workspace_execution',
      {
        title: 'Resolve workspace execution route',
        description:
          'MANDATORY first step in every conversation. Detects whether the active VS Code workspace is a forwarded SFTP workspace and returns its remote root, tool routing, and remote project instructions.',
        _meta: { 'anthropic/alwaysLoad': true },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        inputSchema: {}
      },
      async () => {
        const workspace = await this.callbacks.currentWorkspace();
        return result(workspace ? {
          execution: 'remote',
          workspace,
          fileTools: ['remote_list', 'remote_read', 'remote_write', 'remote_search'],
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
        description: 'Lists configured SFTP workspaces and their remote roots.',
        _meta: { 'anthropic/alwaysLoad': true },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        inputSchema: {}
      },
      async () => result(await this.callbacks.listFolders())
    );
    server.registerTool(
      'current_remote_workspace',
      {
        title: 'Get the current remote workspace',
        description:
          'Returns the remote folder currently open in the VS Code workspace, including its mount name, remote root path, and host. Call this first to discover which remote folder the user is working in. Returns null when no remote workspace is open.',
        inputSchema: {}
      },
      async () => result(await this.callbacks.currentWorkspace())
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
      'remote_read',
      {
        title: 'Read a remote file',
        description: 'Reads a UTF-8 file directly over SFTP, optionally by byte range.',
        inputSchema: {
          mountName: z.string().min(1).optional(),
          path: z.string(),
          offset: z.number().int().min(0).optional(),
          length: z.number().int().min(1).max(1_048_576).optional()
        }
      },
      async (input) => result(await this.callbacks.read(input))
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
            `MCP 端口 ${this.port} 已被其他窗口占用，本窗口将复用已有服务。`
          );
          resolve();
        } else {
          reject(err);
        }
      });
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (this._portUnavailable) {
      // The port was already in use — the first window's server handles
      // requests for all windows.  Don't try to bind `httpServer` which
      // would only wrap the already-closed server handle.
      return;
    }
    this.httpServer = server;
    this.callbacks.log?.(`MCP 已启动：http://127.0.0.1:${this.port}/mcp?token=<hidden>`);
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
