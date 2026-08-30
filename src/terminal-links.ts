import * as path from 'node:path';

export interface RemoteTerminalPathMatch {
  startIndex: number;
  length: number;
  path: string;
  line?: number;
  column?: number;
}

const terminalTokenPattern = /"[^"\r\n]+"(?::\d+(?::\d+)?)?|'[^'\r\n]+'(?::\d+(?::\d+)?)?|[^\s"']+/gu;
const locationSuffixPattern = /^(.*?)(?::([1-9]\d*)(?::([1-9]\d*))?)?$/u;

function looksLikeRemotePath(candidate: string): boolean {
  if (!candidate || candidate === '.' || candidate === '..' || candidate.includes('\\')) {
    return false;
  }
  // Let VS Code's normal URL provider handle URI schemes instead of treating
  // their path portions as files on the active SSH host.
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate)) return false;
  if (candidate.startsWith('/') || candidate.startsWith('./')
    || candidate.startsWith('../')) return true;
  if (candidate.includes('/')) return true;
  // Compiler diagnostics commonly print a basename followed by :line:column.
  return /^(?:[^.:/][^:/]*\.[a-z][a-z0-9_-]*|\.[a-z][a-z0-9_-]*)$/iu.test(candidate);
}

function parseTerminalToken(token: string, tokenStart: number): RemoteTerminalPathMatch | undefined {
  const quoted = /^(["'])(.*?)\1(?::([1-9]\d*)(?::([1-9]\d*))?)?([),;\]}]*)$/u.exec(token);
  if (quoted) {
    const candidate = quoted[2];
    if (!looksLikeRemotePath(candidate)) return undefined;
    return {
      startIndex: tokenStart,
      length: token.length - quoted[5].length,
      path: candidate,
      ...(quoted[3] ? { line: Number(quoted[3]) } : {}),
      ...(quoted[4] ? { column: Number(quoted[4]) } : {})
    };
  }

  const leading = /^[([{<]+/u.exec(token)?.[0] ?? '';
  let core = token.slice(leading.length);
  core = core.replace(/[),;\]}]+$/u, '');
  // GCC, Rust and similar diagnostics put a separator colon after the
  // location (`file:line:column: error`). Do not include that separator in
  // the clickable range.
  if (/:\d+(?::\d+)?:$/u.test(core)) core = core.slice(0, -1);
  if (!core) return undefined;
  const location = locationSuffixPattern.exec(core);
  if (!location || !looksLikeRemotePath(location[1])) return undefined;
  return {
    startIndex: tokenStart + leading.length,
    length: core.length,
    path: location[1],
    ...(location[2] ? { line: Number(location[2]) } : {}),
    ...(location[3] ? { column: Number(location[3]) } : {})
  };
}

/** Extract POSIX file references printed by compilers, test runners and shells. */
export function findRemoteTerminalPaths(line: string): RemoteTerminalPathMatch[] {
  const matches: RemoteTerminalPathMatch[] = [];
  for (const token of line.matchAll(terminalTokenPattern)) {
    const parsed = parseTerminalToken(token[0], token.index);
    if (parsed) matches.push(parsed);
  }
  return matches;
}

/** Resolve a terminal path without allowing POSIX `..` segments to remain. */
export function resolveRemoteTerminalPath(candidate: string, remoteCwd: string): string {
  if (!path.posix.isAbsolute(remoteCwd)) {
    throw new Error(`Remote terminal cwd must be absolute: ${remoteCwd}`);
  }
  return candidate.startsWith('/')
    ? path.posix.normalize(candidate)
    : path.posix.resolve(remoteCwd, candidate);
}
