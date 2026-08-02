const {
  activeWorkspace, readBinding, workspaceForBinding, writeBinding
} = require('./discovery.cjs');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(raw || '{}');
    if (!event.session_id) process.exit(0);
    const existing = readBinding(event.session_id);
    const workspace = existing ? workspaceForBinding(existing) : activeWorkspace();
    if (!workspace) {
      if (!existing) process.exit(0);
      process.stdout.write(JSON.stringify({
        systemMessage: `Serverless Remote mount ${existing.mountName} is disconnected.`,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `This Codex session remains bound to Serverless Remote mount ${existing.mountName}, but that remote window is disconnected. Do not use local filesystem or shell tools for its virtual workspace. Ask the user to reconnect the same mount; the bundled MCP router will resume automatically.`
        }
      }));
      return;
    }
    writeBinding(event.session_id, workspace);
    const context = [
      'SERVERLESS REMOTE WORKSPACE DETECTED.',
      `This Codex session is bound to ${workspace.workspaceUri} (remote root ${workspace.remoteRoot}).`,
      `Before any workspace operation, call resolve_workspace_execution from MCP server ${workspace.mcpServerName}.`,
      'Use remote_list, remote_read, remote_write, and remote_search for files.',
      'Use run_remote_command for Git, builds, tests, packages, processes, and shell commands.',
      'Never use local Bash, apply_patch, Edit, Write, or local filesystem tools for this workspace.',
      `If its tools are deferred, search for ${workspace.mcpServerName} or resolve_workspace_execution first.`,
      `Do not use a different Serverless Remote MCP server; this session is bound to ${workspace.mountName}.`
    ].join(' ');
    process.stdout.write(JSON.stringify({
      systemMessage: `Connected to Serverless Remote mount ${workspace.mountName}.`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context
      }
    }));
  } catch (error) {
    process.stderr.write(`Serverless Remote discovery failed: ${error.message}\n`);
    process.exitCode = 1;
  }
});
