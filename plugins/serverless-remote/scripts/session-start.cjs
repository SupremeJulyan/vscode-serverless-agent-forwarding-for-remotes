const { activeWorkspace, writeBinding } = require('./discovery.cjs');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(raw || '{}');
    const workspace = activeWorkspace();
    if (!workspace || !event.session_id) process.exit(0);
    writeBinding(event.session_id, workspace);
    const context = [
      'SERVERLESS REMOTE WORKSPACE DETECTED.',
      `This Codex session is bound to ${workspace.workspaceUri} (remote root ${workspace.remoteRoot}).`,
      'Before any workspace operation, call the serverless-remote MCP tool resolve_workspace_execution.',
      'Use remote_list, remote_read, remote_write, and remote_search for files.',
      'Use run_remote_command for Git, builds, tests, packages, processes, and shell commands.',
      'Never use local Bash, apply_patch, Edit, Write, or local filesystem tools for this workspace.',
      'If the MCP tools are deferred, search for serverless-remote or resolve_workspace_execution first.'
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
