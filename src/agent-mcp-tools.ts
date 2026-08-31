import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListResourcesRequestSchema, ListResourceTemplatesRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const directAgentMcpInstructions =
  'This MCP server is only for SAFS remote workspaces. Do not call SAFS tools for ordinary local workspaces. '
  + 'Only for an explicit SAFS task or known safs:// context, call safs_get_remote_workspace once to bind this window workspace. Virtual remote files are NOT present in the agent host filesystem. '
  + 'Use the returned workspace and its remote_list, remote_write, remote_search, current_remote_file, and run_remote_command tools for workspace operations. Never substitute the local filesystem or local shell. '
  + 'File content is never returned into the conversation; inspect files with run_remote_command (head, sed, grep, tail, wc, diff) on the remote host instead. '
  + 'To learn which file is open in the VS Code window, call current_remote_file for its path and metadata. '
  + 'The selected workspace remains bound for later tool calls.';

export const routedAgentMcpInstructions = [
  'This MCP server is only for SAFS remote workspaces; do not call SAFS tools for ordinary local workspaces.',
  'For an explicit SAFS task or known safs:// context, call safs_get_remote_workspace once with the Agent actual current working directory in agentCwd. An exact SAFS placeholder match binds automatically; if it does not match, one uniquely focused SAFS window also binds automatically.',
  'If the cwd does not match exactly or is ambiguous, the tool returns candidates. Ask the user to choose in the Agent conversation, then call safs_switch_remote_workspace with that workspaceId and userConfirmed=true. Never select in the same turn as asking, and never treat one candidate as consent. No VS Code Quick Pick is used.',
  'When the user asks to list available SAFS workspaces, change host/configuration, or switch away from the current binding, call safs_switch_remote_workspace without a workspaceId. Never use safs_get_remote_workspace for switching.',
  'A successful safs_switch_remote_workspace call cancels the previous task. Stop the current workflow and wait for a new user request before calling workspace tools.',
  'Use the returned workspace and its remote_list, remote_write, remote_search, current_remote_file, and run_remote_command tools for that workspace.',
  'File content is never returned into the conversation; inspect files with run_remote_command (head, sed, grep, tail, wc, diff) on the remote host instead.',
  'To learn which file is open in the VS Code window, call current_remote_file for its path and metadata.',
  'Never use local shell or local filesystem tools for a safs workspace because its files do not exist locally.',
  'Pass the bindingId returned by safs_get_remote_workspace to every later workspace tool call. It stays pinned to the matched window instance. If it expires, stop and report it; never guess, rebind, or silently switch workspaces.'
].join(' ');

export type AgentMcpToolName =
  | 'safs_get_remote_workspace'
  | 'safs_switch_remote_workspace'
  | 'current_remote_file'
  | 'remote_list'
  | 'remote_write'
  | 'remote_search'
  | 'run_remote_command';

interface AgentMcpToolDefinition {
  name: AgentMcpToolName;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
}

function toolDefinitions(routed: boolean): AgentMcpToolDefinition[] {
  const binding: Record<string, z.ZodTypeAny> = routed
    ? { bindingId: z.string().min(1) }
    : {};
  const definitions: AgentMcpToolDefinition[] = [
    {
      name: 'safs_get_remote_workspace',
      title: routed ? 'Bind a SAFS remote workspace' : 'Bind this SAFS remote workspace',
      description: routed
        ? 'Gets and initially binds the SAFS workspace matching the Agent actual current working directory in agentCwd, or the uniquely focused SAFS window when cwd does not match. This tool never switches workspaces. If neither is unique, ask the user to choose a returned candidate and use safs_switch_remote_workspace. The returned bindingId stays pinned to that window instance.'
        : 'Returns the SAFS workspace served by this exact VS Code window for later remote tool calls.',
      inputSchema: routed ? {
        agentCwd: z.string().min(1)
      } : {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'current_remote_file',
      title: 'Get the currently open remote file',
      description: routed
        ? 'Returns the remote file open in the active VS Code editor of the bound window (absolute path, relative path, size, dirty), or null when none is open.'
        : 'Returns the remote file open in the active VS Code editor of this window: absolute path, relative path, size, and dirty (unsaved changes). null when none is open.',
      inputSchema: binding,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'remote_list',
      title: 'List a remote directory',
      description: 'Lists files directly over SFTP. Relative paths start at the current VS Code workspace root. Entries are capped at 500 (raise limit if needed); large directories return truncated with total.',
      inputSchema: {
        ...binding,
        path: z.string().optional(),
        limit: z.number().int().min(1).max(10000).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'remote_write',
      title: 'Write a remote file',
      description: 'Creates or replaces a UTF-8 file directly over SFTP.',
      inputSchema: { ...binding, path: z.string().min(1), content: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    {
      name: 'remote_search',
      title: 'Search remote files',
      description: 'Searches file contents on the remote SSH host. Relative paths start at the current VS Code workspace root. Results are capped (200 matches, lines trimmed to 300 chars).',
      inputSchema: {
        ...binding, query: z.string().min(1), path: z.string().optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'run_remote_command',
      title: 'Run a remote SSH command',
      description: routed
        ? 'Runs a command on the bound SSH host. The default working directory is the current VS Code workspace root.'
        : 'Runs a shell command on the selected SSH host. The default working directory is the current VS Code workspace root.',
      inputSchema: {
        ...binding, command: z.string().min(1), remoteCwd: z.string().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    }
  ];
  if (routed) {
    definitions.splice(1, 0, {
      name: 'safs_switch_remote_workspace',
      title: 'Switch SAFS remote workspace',
      description: 'Lists active SAFS workspaces when called without workspaceId. Ask the user to choose a candidate, then call again with workspaceId and userConfirmed=true. A successful switch returns a new bindingId and cancels the previous task. No VS Code Quick Pick or focused-window fallback is used.',
      inputSchema: {
        workspaceId: z.string().min(1).optional(),
        userConfirmed: z.literal(true).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    });
  }
  return definitions;
}

export function configureAgentMcpResources(server: McpServer): void {
  server.server.registerCapabilities({ resources: {} });
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async () => ({ resourceTemplates: [] })
  );
}

export function registerAgentMcpTools(
  server: McpServer,
  options: {
    routed: boolean;
    invoke(name: AgentMcpToolName, input: Record<string, unknown>): Promise<any>;
  }
): void {
  for (const definition of toolDefinitions(options.routed)) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations
      },
      async (input) => options.invoke(
        definition.name, (input ?? {}) as Record<string, unknown>
      )
    );
  }
}
