import type { CommandPlan, PlatformKind } from './platform';

const sshConnectionDropPatterns = [
  /connection reset by peer/i,
  /connection (?:closed|terminated) (?:by remote|remotely)/i,
  /connection unexpectedly closed/i,
  /broken pipe/i,
  /kex_exchange_identification.*closed/i,
  /connection (?:refused|timed out)/i,
  /no route to host/i,
  /network is unreachable/i
];

export function shouldRecoverTerminalExit(input: {
  processExit: boolean;
  exitCode: number | undefined;
  cleanExit: boolean;
  systemSsh: boolean;
  autoReconnect: boolean;
  diagnosticText: string;
}): boolean {
  if (!input.processExit || input.cleanExit) return false;
  return input.exitCode !== 0
    || sshConnectionDropPatterns.some((pattern) => pattern.test(input.diagnosticText))
    || (input.autoReconnect && input.systemSsh);
}

const ansiPattern = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/**
 * Wrap a system SSH terminal so its stderr survives the short-lived terminal.
 * stdout and stdin remain attached to VS Code's terminal. On Unix stderr is
 * mirrored live with tee; PowerShell replays captured stderr when SSH exits.
 */
export function terminalDiagnosticPlan(
  kind: PlatformKind, resolvedCommand: string, plan: CommandPlan, logFile: string
): CommandPlan {
  if (kind === 'windows') {
    const script = [
      '$log = $env:SAFS_TERMINAL_ERROR_LOG',
      '$exe = $args[0]',
      '$nativeArgs = if ($args.Length -gt 1) { $args[1..($args.Length - 1)] } else { @() }',
      '& $exe @nativeArgs 2> $log',
      '$code = $LASTEXITCODE',
      'if ($code -ne 0 -and (Test-Path -LiteralPath $log)) {',
      '  Get-Content -LiteralPath $log | ForEach-Object { [Console]::Error.WriteLine($_) }',
      '}',
      'exit $code'
    ].join('\n');
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, resolvedCommand,
        ...plan.args],
      cwd: plan.cwd,
      env: { ...plan.env, SAFS_TERMINAL_ERROR_LOG: logFile }
    };
  }
  const script = [
    '"$@" 2> >(tee -a -- "$SAFS_TERMINAL_ERROR_LOG" >&2)',
    'status=$?',
    'exit "$status"'
  ].join('; ');
  return {
    command: '/bin/bash',
    args: ['-c', script, 'safs-terminal', resolvedCommand, ...plan.args],
    cwd: plan.cwd,
    env: { ...plan.env, SAFS_TERMINAL_ERROR_LOG: logFile }
  };
}

/** Windows PowerShell 5 may write redirected native stderr as UTF-16LE. */
export function decodeTerminalDiagnostic(value: Uint8Array): string {
  const buffer = Buffer.from(value);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 200));
  const oddNulls = [...sample].filter((byte, index) => index % 2 === 1 && byte === 0).length;
  if (sample.length >= 4 && oddNulls >= Math.floor(sample.length / 4)) {
    return buffer.toString('utf16le');
  }
  return buffer.toString('utf8');
}

/** Keep terminal diagnostics readable and safe for a line-oriented output channel. */
export function cleanTerminalDiagnostic(value: string, maxLength = 64 * 1024): {
  text: string; truncated: boolean;
} {
  const cleaned = value.replace(ansiPattern, '').replace(/\r/g, '').trim();
  if (cleaned.length <= maxLength) return { text: cleaned, truncated: false };
  return { text: cleaned.slice(-maxLength), truncated: true };
}
