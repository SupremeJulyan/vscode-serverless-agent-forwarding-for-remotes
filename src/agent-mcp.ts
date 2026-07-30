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
      { name: 'serverless-remote-ssh', version: '0.10.0' },
      {
        instructions:
          'When cwd is inside a forwarded SSHFS mount, use run_remote_command for builds, tests, Git, package managers, and other commands that depend on the remote environment. Continue editing files with the agent file tools.'
      }
    );
    server.registerTool(
      'list_forwarded_mounts',
      {
        title: 'List forwarded SSHFS mounts',
        description: 'Lists mounted Serverless Remote SSH folders currently enabled for agents.',
        inputSchema: {}
      },
      async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify(await this.callbacks.listMounts(), null, 2)
        }]
      })
    );
    server.registerTool(
      'run_remote_command',
      {
        title: 'Run a command in the remote SSH environment',
        description:
          'Maps a cwd inside an enabled SSHFS mount to the same remote directory and runs the command through the configured SSH or WSL bridge.',
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
      async (input) => ({
        content: [{
          type: 'text',
          text: JSON.stringify(await this.callbacks.run(input), null, 2)
        }]
      })
    );
    return server;
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    const app = express();
    app.use(express.json({ limit: '1mb' }));
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
