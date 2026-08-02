const { readBinding, workspaceForBinding, writeBinding } = require('./discovery.cjs');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(raw || '{}');
    const binding = event.session_id ? readBinding(event.session_id) : null;
    if (!binding) process.exit(0);
    if (/^mcp__serverless-remote__/.test(event.tool_name || '')) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...(event.tool_input || {}), _sessionId: event.session_id }
        }
      }));
      return;
    }
    const workspace = workspaceForBinding(binding);
    if (workspace && workspace.instanceId !== binding.instanceId) {
      writeBinding(event.session_id, workspace);
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: [
          'This session is bound to a Serverless Remote virtual workspace.',
          workspace
            ? 'Local shell and local file-editing tools cannot access that workspace.'
            : `Remote mount ${binding.mountName} is disconnected; reconnect it in VS Code and retry.`,
          'Use the bundled serverless-remote MCP tools; they automatically follow the reconnected window.'
        ].join(' ')
      }
    }));
  } catch (error) {
    process.stderr.write(`Serverless Remote guard failed: ${error.message}\n`);
    process.exitCode = 1;
  }
});
