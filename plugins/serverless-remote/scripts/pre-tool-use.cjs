const { readBinding } = require('./discovery.cjs');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(raw || '{}');
    const binding = event.session_id ? readBinding(event.session_id) : null;
    if (!binding) process.exit(0);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: [
          'This session is bound to a Serverless Remote virtual workspace.',
          'Local shell and local file-editing tools cannot access that workspace.',
          `Call resolve_workspace_execution on ${binding.mcpServerName}, then use its remote_* tools or run_remote_command.`
        ].join(' ')
      }
    }));
  } catch (error) {
    process.stderr.write(`Serverless Remote guard failed: ${error.message}\n`);
    process.exitCode = 1;
  }
});
