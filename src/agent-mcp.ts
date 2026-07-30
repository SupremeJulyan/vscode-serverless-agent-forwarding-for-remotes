import * as http from 'node:http';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface ForwardedMountInfo {
  name: string;
  localRoot: string;
  remoteRoot: string;
  host: string;
}

export interface AgentMcpCallbacks {
  listMounts(): Promise<ForwardedMountInfo[]>;
  run(input: { command: string; cwd?: string; mountName?: string }): Promise<unknown>;
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

  get running(): boolean {
    return this.httpServer !== undefined;
  }

  private createProtocolServer(): McpServer {
    const server = new McpServer(
      { name: 'serverless-remote-ssh', version: '1.0.0' },
      {
        instructions:
          'IMPORTANT remote-routing rule: first call list_forwarded_mounts when the current working directory may be inside an SSHFS-forwarded folder. When cwd is inside a listed localRoot, you MUST use run_remote_command for every shell command that depends on the remote machine or its files, including operating-system and hardware inspection, environment diagnostics, builds, tests, Git, package managers, and process or service checks. Do not run those commands in the agent host shell. Continue reading and editing mounted files with the agent file tools.'
      }
    );
    server.registerTool(
      'list_forwarded_mounts',
      {
        title: 'List forwarded SSHFS mounts',
        description:
          'Lists active SSHFS-forwarded folders and their local-to-remote roots. Call this first to determine whether the agent cwd/workspace is remote-backed before running shell commands or inspecting the operating system/environment.',
        inputSchema: {}
      },
      async () => {
        const startedAt = performance.now();
        const mounts = await this.callbacks.listMounts();
        this.callbacks.log?.(
          `工具 list_forwarded_mounts 完成：${mounts.length} 个挂载，${
            (performance.now() - startedAt).toFixed(1)
          } ms`
        );
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(mounts, null, 2)
          }]
        };
      }
    );
    server.registerTool(
      'run_remote_command',
      {
        title: 'Run a command in the remote SSH environment',
        description:
          'Runs a shell command on the SSH host for a forwarded mount, mapping a local cwd to its remote directory. Use it instead of the local shell for OS/kernel/hardware inspection (for example uname or /etc/os-release), environment diagnostics, builds, tests, Git, package managers, processes, services, and all other commands whose result or side effects belong to the remote machine.',
        annotations: {
          destructiveHint: true,
          openWorldHint: true
        },
        inputSchema: {
          command: z.string().min(1).describe('Shell command to run remotely.'),
          cwd: z.string().optional().describe('Absolute local cwd inside the SSHFS mount.'),
          mountName: z.string().optional().describe('Forwarded mount name when cwd is unavailable.')
        }
      },
      async (input) => {
        const startedAt = performance.now();
        this.callbacks.log?.(
          `工具 run_remote_command 开始：mount=${input.mountName ?? '自动匹配'}${
            input.cwd ? `，cwd=${input.cwd}` : ''
          }`
        );
        try {
          const result = await this.callbacks.run(input);
          this.callbacks.log?.(
            `工具 run_remote_command 完成：${(performance.now() - startedAt).toFixed(1)} ms`
          );
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }]
          };
        } catch (error) {
          this.callbacks.log?.(
            `工具 run_remote_command 失败：${
              error instanceof Error ? error.message : String(error)
            }`
          );
          throw error;
        }
      }
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
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.httpServer = server;
    this.callbacks.log?.(`服务已启动：http://127.0.0.1:${this.port}/mcp?token=<hidden>`);
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    this.callbacks.log?.('服务已停止');
  }
}
