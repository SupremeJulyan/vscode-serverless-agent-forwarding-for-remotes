import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { shellQuote } from './shell-quote';

export type RemoteShellKind = 'bash' | 'zsh' | 'fish' | 'unsupported';

export interface RemoteShellIntegrationScripts {
  bash: string;
  fish: string;
  zshEnv: string;
  zshProfile: string;
  zshRc: string;
}

const cwdOscPrefix = '\x1b]633;P;Cwd=';
const maxReportedCwdLength = 4096;
const shellProbeMaxLength = 4096;
let integrationBundlePath: string | undefined;
let scriptsPromise: Promise<RemoteShellIntegrationScripts> | undefined;

export function setRemoteShellIntegrationBundlePath(value: string): void {
  integrationBundlePath = value;
  scriptsPromise = undefined;
}

export function loadRemoteShellIntegrationScripts(): Promise<RemoteShellIntegrationScripts> {
  if (!integrationBundlePath) {
    return Promise.reject(new Error('Remote shell integration bundle path is not initialized'));
  }
  scriptsPromise ??= Promise.all([
    readFile(path.join(integrationBundlePath, 'bash.sh'), 'utf8'),
    readFile(path.join(integrationBundlePath, 'fish.fish'), 'utf8'),
    readFile(path.join(integrationBundlePath, 'zsh-env.zsh'), 'utf8'),
    readFile(path.join(integrationBundlePath, 'zsh-profile.zsh'), 'utf8'),
    readFile(path.join(integrationBundlePath, 'zsh-rc.zsh'), 'utf8')
  ]).then(([bash, fish, zshEnv, zshProfile, zshRc]) => ({
    bash, fish, zshEnv, zshProfile, zshRc
  }));
  return scriptsPromise;
}

export function remoteShellProbeCommand(): string {
  return `printf '%s' "\${SHELL:-/bin/sh}"`;
}

export function normalizeRemoteShellPath(value: string): string | undefined {
  const shellPath = value.trim();
  if (!shellPath || shellPath.length > shellProbeMaxLength
    || !path.posix.isAbsolute(shellPath) || /[\0-\x1f\x7f]/u.test(shellPath)) {
    return undefined;
  }
  return path.posix.normalize(shellPath);
}

export function remoteShellKind(shellPath: string | undefined): RemoteShellKind {
  switch (shellPath ? path.posix.basename(shellPath) : '') {
    case 'bash': return 'bash';
    case 'zsh': return 'zsh';
    case 'fish': return 'fish';
    default: return 'unsupported';
  }
}

function heredoc(delimiter: string, contents: string): string {
  const body = contents.endsWith('\n') ? contents : `${contents}\n`;
  if (body.split('\n').includes(delimiter)) {
    throw new Error(`Remote shell integration heredoc collision: ${delimiter}`);
  }
  return `<<'${delimiter}'\n${body}${delimiter}`;
}

function bashLoginCommand(
  shellPath: string, script: string, sessionId: string
): string {
  const delimiter = `SAFS_BASH_${sessionId}`;
  return `{ if [ -r /dev/fd/3 ]; then `
    + `exec ${shellQuote(shellPath)} --init-file /dev/fd/3 -i; fi; `
    + `exec ${shellQuote(shellPath)} -l; } 3${heredoc(delimiter, script)}`;
}

function fishLoginCommand(
  shellPath: string, script: string, sessionId: string
): string {
  const delimiter = `SAFS_FISH_${sessionId}`;
  return `{ if [ -r /dev/fd/3 ] `
    + `&& ${shellQuote(shellPath)} --help 2>&1 | command grep -q -- '--init-command'; then `
    + `exec ${shellQuote(shellPath)} -l --init-command 'source /dev/fd/3'; fi; `
    + `exec ${shellQuote(shellPath)} -l; } 3${heredoc(delimiter, script)}`;
}

function zshFile(
  target: string, delimiter: string, contents: string
): string {
  return `command cat > "\$__safs_dir/${target}" ${heredoc(delimiter, contents)}\n`;
}

function zshLoginCommand(
  shellPath: string, scripts: RemoteShellIntegrationScripts, sessionId: string
): string {
  const prefix = `SAFS_ZSH_${sessionId}`;
  return `if ! __safs_dir=$(command mktemp -d `
    + `"\${TMPDIR:-/tmp}/safs-shell-integration.XXXXXXXX"); then `
    + `exec ${shellQuote(shellPath)} -l; exit 1; fi\n`
    + `__safs_cleanup() { command rm -f -- "$__safs_dir/.zshenv" `
    + `"$__safs_dir/.zprofile" "$__safs_dir/.zshrc"; `
    + `command rmdir -- "$__safs_dir" 2>/dev/null; }\n`
    + `trap '__safs_cleanup' 0 1 2 15\n`
    + `command chmod 700 "$__safs_dir" || exit 1\n`
    + `umask 077\n`
    + zshFile('.zshenv', `${prefix}_ENV`, scripts.zshEnv)
    + zshFile('.zprofile', `${prefix}_PROFILE`, scripts.zshProfile)
    + zshFile('.zshrc', `${prefix}_RC`, scripts.zshRc)
    + `if [ ! -s "$__safs_dir/.zshenv" ] || [ ! -s "$__safs_dir/.zprofile" ] `
    + `|| [ ! -s "$__safs_dir/.zshrc" ]; then __safs_cleanup; trap - 0 1 2 15; `
    + `exec ${shellQuote(shellPath)} -l; exit 1; fi\n`
    + `SAFS_INTEGRATION_DIR="$__safs_dir"\n`
    + `SAFS_USER_ZDOTDIR="\${ZDOTDIR:-$HOME}"\n`
    + `ZDOTDIR="$__safs_dir"\n`
    + `export SAFS_INTEGRATION_DIR SAFS_USER_ZDOTDIR ZDOTDIR\n`
    + `trap - 0 1 2 15\n`
    + `exec ${shellQuote(shellPath)} -l\n`
    + `__safs_status=$?; __safs_cleanup; exit "$__safs_status"`;
}

/**
 * Build a shell-specific, session-only integration launch command. Bash and
 * Fish read their integration from an inherited file descriptor. Zsh uses a
 * private temporary ZDOTDIR which removes itself after .zshrc is loaded.
 */
export function remoteIntegratedLoginCommand(
  shellPath: string | undefined,
  remoteCwd: string | undefined,
  scripts: RemoteShellIntegrationScripts | undefined,
  sessionId: string
): string {
  if (!/^[a-f0-9]{24}$/u.test(sessionId)) {
    throw new Error('Invalid remote shell integration session id');
  }
  const normalizedShell = normalizeRemoteShellPath(shellPath ?? '');
  const shell = normalizedShell ?? '${SHELL:-/bin/sh}';
  const cd = remoteCwd ? `cd -- ${shellQuote(remoteCwd)} && ` : '';
  if (!scripts || !normalizedShell) {
    return `${cd}exec "\${SHELL:-/bin/sh}" -l`;
  }
  switch (remoteShellKind(normalizedShell)) {
    case 'bash': return cd + bashLoginCommand(normalizedShell, scripts.bash, sessionId);
    case 'fish': return cd + fishLoginCommand(normalizedShell, scripts.fish, sessionId);
    case 'zsh': return cd + zshLoginCommand(normalizedShell, scripts, sessionId);
    case 'unsupported': return `${cd}exec ${shellQuote(shell)} -l`;
  }
}

/** Decode the escaping used by the OSC 633 property protocol. */
export function decodeShellIntegrationValue(value: string): string {
  return value.replace(/\\(\\|x([0-9a-f]{2}))/giu, (_match, slash: string, hex?: string) =>
    hex ? String.fromCharCode(Number.parseInt(hex, 16)) : slash
  );
}

/** Parse OSC 633 cwd reports even when an SSH data frame splits the sequence. */
export class RemoteCwdOscTracker {
  private pending = '';

  push(data: string): string[] {
    this.pending += data;
    const paths: string[] = [];
    while (this.pending) {
      const start = this.pending.indexOf(cwdOscPrefix);
      if (start < 0) {
        this.pending = this.prefixTail(this.pending);
        break;
      }
      if (start > 0) this.pending = this.pending.slice(start);
      const payloadStart = cwdOscPrefix.length;
      const bell = this.pending.indexOf('\x07', payloadStart);
      const stringTerminator = this.pending.indexOf('\x1b\\', payloadStart);
      const end = bell < 0
        ? stringTerminator
        : stringTerminator < 0 ? bell : Math.min(bell, stringTerminator);
      if (end < 0) {
        if (this.pending.length > cwdOscPrefix.length + maxReportedCwdLength + 2) {
          this.pending = this.pending.slice(1);
          continue;
        }
        break;
      }
      const encoded = this.pending.slice(payloadStart, end);
      const terminatorLength = end === stringTerminator ? 2 : 1;
      this.pending = this.pending.slice(end + terminatorLength);
      const reported = decodeShellIntegrationValue(encoded);
      if (encoded.length <= maxReportedCwdLength
        && reported.length <= maxReportedCwdLength
        && path.posix.isAbsolute(reported)
        && !/[\0-\x1f\x7f]/u.test(reported)) {
        paths.push(path.posix.normalize(reported));
      }
    }
    return paths;
  }

  private prefixTail(value: string): string {
    const max = Math.min(value.length, cwdOscPrefix.length - 1);
    for (let length = max; length > 0; length--) {
      if (value.endsWith(cwdOscPrefix.slice(0, length))) return value.slice(-length);
    }
    return '';
  }
}
