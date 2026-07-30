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
}

export interface AgentMcpCallbacks {
  listFolders(): Promise<RemoteFolderInfo[]>;
  activeFolder?(): Promise<RemoteFolderInfo | undefined>;
  list(input: { mountName: string; path?: string }): Promise<unknown>;
  read(input: { mountName: string; path: string; offset?: number; length?: number }): Promise<unknown>;
  write(input: { mountName: string; path: string; content: string }): Promise<unknown>;
  search(input: { mountName: string; query: string; path?: string }): Promise<unknown>;
  run(input: { command: string; mountName: string; remoteCwd?: string }): Promise<unknown>;
  log?(message: string): void;
}

export class AgentMcpServer {
  private httpServer: http.Server | undefined;

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly callbacks: AgentMcpCallbacks
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp?token=${encodeURIComponent(this.token)}`;
  }

  private createProtocolServer(activeFolder?: RemoteFolderInfo): McpServer {
    const workspaceInstruction = activeFolder
      ? `The active VS Code workspace is remote folder "${activeFolder.name}" `
        + `(${activeFolder.workspaceUri}), rooted at ${activeFolder.remoteRoot} on `
        + `${activeFolder.host}. Automatically use mountName "${activeFolder.name}". `
        + 'Do not use local filesystem or local shell tools for this workspace.'
      : 'When the VS Code workspace uses the serverless-sftp scheme, call '
        + 'get_active_remote_workspace and use these remote tools instead of local tools.';
    const server = new McpServer(
      { name: 'serverless-remote-ssh', version: '1.0.0' },
      {
        instructions:
          `Remote files are not local files. ${workspaceInstruction} `
          + 'Use remote_list, remote_read, remote_write, and remote_search for files. '
          + 'Use run_remote_command for builds, tests, Git, and shell commands on the SSH host. '
          + 'Never assume a local filesystem path exists for a remote workspace.'
      }
    );
    const result = (value: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
    });
    server.registerTool(
      'get_active_remote_workspace',
      {
        title: 'Get the active Serverless Remote workspace',
        description:
          'Call this first when the current VS Code workspace is a serverless-sftp remote '
          + 'folder. It returns the mountName required by all remote tools.',
        inputSchema: {}
      },
      async () => result(await this.callbacks.activeFolder?.() ?? null)
    );
    server.registerTool(
      'list_remote_folders',
      {
        title: 'List SFTP remote folders',
        description:
          'Lists configured SFTP workspaces and their remote roots. Use these instead of local '
          + 'filesystem paths for a serverless-sftp VS Code workspace.',
        inputSchema: {}
      },
      async () => result(await this.callbacks.listFolders())
    );
    server.registerTool(
      'remote_list',
      {
        title: 'List a remote directory',
        description:
          'Lists files in a serverless-sftp workspace directly over SFTP. Paths are relative '
          + 'to its remote root; prefer this over local filesystem tools.',
        inputSchema: {
          mountName: z.string().min(1),
          path: z.string().optional()
        }
      },
      async (input) => result(await this.callbacks.list(input))
    );
    server.registerTool(
      'remote_read',
      {
        title: 'Read a remote file',
        description:
          'Reads a UTF-8 file from a serverless-sftp workspace. Prefer this over every local '
          + 'file-reading tool for that workspace.',
        inputSchema: {
          mountName: z.string().min(1),
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
        description:
          'Creates or replaces a UTF-8 file in a serverless-sftp workspace. Prefer this over '
          + 'every local file-writing tool for that workspace.',
        annotations: { destructiveHint: true },
        inputSchema: {
          mountName: z.string().min(1),
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
        description:
          'Searches files in a serverless-sftp workspace on its SSH host. Prefer this over '
          + 'local search tools for that workspace.',
        inputSchema: {
          mountName: z.string().min(1),
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
        description:
          'Runs builds, tests, Git, and shell commands for a serverless-sftp workspace on its '
          + 'SSH host. Prefer this over local shell tools for that workspace.',
        annotations: { destructiveHint: true, openWorldHint: true },
        inputSchema: {
          mountName: z.string().min(1),
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
    app.use(express.json({ limit: '2mb' }));
    app.all('/mcp', async (request, response) => {
      if (request.query.token !== this.token) {
        response.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (request.method !== 'POST') {
        response.status(405).json({ error: 'Method not allowed' });
        return;
      }
      const protocol = this.createProtocolServer(await this.callbacks.activeFolder?.());
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
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
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
