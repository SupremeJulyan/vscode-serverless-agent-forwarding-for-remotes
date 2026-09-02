import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListResourcesRequestSchema, ListResourceTemplatesRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const directAgentMcpInstructions =
  'This MCP server is only for SAFS remote workspaces. Do not call SAFS tools for ordinary local workspaces. '
  + 'Only for an explicit SAFS task or known safs:// context, call safs_get_remote_workspace once to bind this window workspace. Virtual remote files are NOT present in the agent host filesystem. '
  + 'Use the returned workspace and its remote_list, remote_read, remote_write, remote_delete, remote_chmod, remote_move, remote_search, remote_upload, remote_download, current_remote_file, and run_remote_command tools for workspace operations. Never substitute the local filesystem or local shell. '
  + 'Use remote_read for bounded UTF-8 text reads; use remote_download for binary files, large files, and directories. '
  + 'Use remote_delete, remote_chmod, and remote_move instead of shell rm, chmod, or mv when changing workspace files. '
  + 'For remote_upload and remote_download, local paths must stay inside the Agent current cwd staging directory. '
  + 'To learn which file is open in the VS Code window, call current_remote_file for its path and metadata. '
  + 'The selected workspace remains bound for later tool calls.';

export const routedAgentMcpInstructions = [
  'This MCP server is only for SAFS remote workspaces; do not call SAFS tools for ordinary local workspaces.',
  'For an explicit SAFS task or known safs:// context, call safs_get_remote_workspace once with the Agent actual current working directory in agentCwd. An exact SAFS placeholder match binds automatically; if it does not match, one uniquely focused SAFS window also binds automatically.',
  'If the cwd does not match exactly or is ambiguous, the tool returns candidates. Ask the user to choose in the Agent conversation, then call safs_switch_remote_workspace with that workspaceId and userConfirmed=true. Never select in the same turn as asking, and never treat one candidate as consent. No VS Code Quick Pick is used.',
  'When the user asks to list available SAFS workspaces, change host/configuration, or switch away from the current binding, call safs_switch_remote_workspace without a workspaceId. Never use safs_get_remote_workspace for switching.',
  'A successful safs_switch_remote_workspace call cancels the previous task. Stop the current workflow and wait for a new user request before calling workspace tools.',
  'Use the returned workspace and its remote_list, remote_read, remote_write, remote_delete, remote_chmod, remote_move, remote_search, remote_upload, remote_download, current_remote_file, and run_remote_command tools for that workspace.',
  'Use remote_read for bounded UTF-8 text reads; use remote_download for binary files, large files, and directories.',
  'Use remote_delete, remote_chmod, and remote_move instead of shell rm, chmod, or mv when changing workspace files.',
  'For remote_upload and remote_download, local paths must stay inside the Agent current cwd staging directory.',
  'To learn which file is open in the VS Code window, call current_remote_file for its path and metadata.',
  'Never use local shell or local filesystem tools for a safs workspace because its files do not exist locally.',
  'Pass the bindingId returned by safs_get_remote_workspace to every later workspace tool call. It stays pinned to the matched window instance. If it expires, stop and report it; never guess, rebind, or silently switch workspaces.'
].join(' ');

export type AgentMcpToolName =
  | 'safs_get_remote_workspace'
  | 'safs_switch_remote_workspace'
  | 'current_remote_file'
  | 'remote_list'
  | 'remote_read'
  | 'remote_write'
  | 'remote_delete'
  | 'remote_chmod'
  | 'remote_move'
  | 'remote_upload'
  | 'remote_download'
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
      name: 'remote_read',
      title: 'Read a remote text file',
      description: 'Reads a bounded UTF-8 text chunk directly over SFTP. Relative paths start at the current VS Code workspace root; absolute paths may inspect files outside it for environment diagnostics. offset and length are byte counts; length defaults to and is capped at 65536 bytes. Binary or invalid UTF-8 content is rejected; use remote_download instead. Continue truncated reads with nextOffset.',
      inputSchema: {
        ...binding,
        path: z.string().min(1),
        offset: z.number().int().min(0).optional(),
        length: z.number().int().min(1).max(65536).optional()
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
      name: 'remote_delete',
      title: 'Delete a remote file or directory',
      description: 'Deletes a path directly over SFTP after verifying it stays inside the current remote workspace. Set recursive=true for a non-empty directory. The workspace root itself cannot be deleted.',
      inputSchema: {
        ...binding,
        path: z.string().min(1),
        recursive: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    {
      name: 'remote_chmod',
      title: 'Change remote file permissions',
      description: 'Changes one remote file or directory mode directly over SFTP after real-path workspace validation. mode is exactly three octal digits such as 644 or 755; setuid, setgid, and sticky bits are not accepted.',
      inputSchema: {
        ...binding,
        path: z.string().min(1),
        mode: z.string().regex(/^[0-7]{3}$/)
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    {
      name: 'remote_move',
      title: 'Move or rename a remote path',
      description: 'Moves or renames a remote file or directory directly over SFTP. Both paths and their real parents must stay inside the current remote workspace. overwrite defaults to false. The workspace root itself cannot be moved.',
      inputSchema: {
        ...binding,
        sourcePath: z.string().min(1),
        targetPath: z.string().min(1),
        overwrite: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    {
      name: 'remote_upload',
      title: 'Upload local files to the remote workspace',
      description: 'Streams local files or folders to a remote directory with VS Code progress and cancellation. The Agent supplies paths directly; no path picker is opened and file bytes do not pass through the MCP conversation. localPaths must be absolute existing paths inside the Agent current cwd staging directory. Relative remoteDirectory starts at the current remote workspace root.',
      inputSchema: {
        ...binding,
        localPaths: z.array(z.string().min(1)).min(1),
        remoteDirectory: z.string().min(1)
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    {
      name: 'remote_download',
      title: 'Download a remote file or folder locally',
      description: 'Streams a remote file or folder to localPath with VS Code progress and cancellation. The Agent supplies both paths directly; no path picker is opened. Relative remotePath starts at the current remote workspace root. localPath is the exact absolute destination file or directory path inside the Agent current cwd staging directory.',
      inputSchema: {
        ...binding,
        remotePath: z.string().min(1),
        localPath: z.string().min(1)
      },
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
        ? 'Runs a command on the bound SSH host. The default working directory is the current VS Code workspace root. This is not a filesystem sandbox: the command has all permissions of the configured SSH account; prefer structured file tools for workspace changes.'
        : 'Runs a shell command on the selected SSH host. The default working directory is the current VS Code workspace root. This is not a filesystem sandbox: the command has all permissions of the configured SSH account; prefer structured file tools for workspace changes.',
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
