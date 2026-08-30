import * as path from 'node:path';

export interface RemoteTerminalPathMatch {
  startIndex: number;
  length: number;
  path: string;
  line?: number;
  column?: number;
}

export interface RemotePathSearchEntry {
  name: string;
  type: string;
}

export interface RemotePathSearchResult {
  matches: string[];
  truncated: boolean;
}

export interface TerminalCwdReport {
  path: string;
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

/**
 * Prefer VS Code's live shell-integration cwd over the directory recorded
 * when the SSH terminal was opened. Remote shells commonly report this as a
 * `file:///...` URI with an empty authority, so the URI scheme/authority
 * cannot be used to decide whether the path belongs to the local machine.
 */
export function resolveRemoteTerminalCwdReport(
  reported: TerminalCwdReport | undefined, fallback: string
): string {
  if (!reported || !path.posix.isAbsolute(reported.path)) return fallback;
  return path.posix.normalize(reported.path);
}

/**
 * Find a relative terminal path below the current SAFS workspace. This is a
 * bounded breadth-first fallback for commands such as `ls subdir`, whose
 * output contains only basenames and therefore omits the directory argument.
 */
export async function findRemotePathCandidates(
  searchRoot: string,
  candidate: string,
  readDirectory: (directory: string) => Promise<RemotePathSearchEntry[]>,
  options: {
    maxEntries?: number;
    maxDepth?: number;
    maxMatches?: number;
    cancelled?: () => boolean;
  } = {}
): Promise<RemotePathSearchResult> {
  if (!path.posix.isAbsolute(searchRoot) || path.posix.isAbsolute(candidate)) {
    return { matches: [], truncated: false };
  }
  const suffix = path.posix.normalize(candidate.replace(/^(?:\.\/)+/u, ''));
  if (!suffix || suffix === '.' || suffix === '..' || suffix.startsWith('../')) {
    return { matches: [], truncated: false };
  }
  const maxEntries = options.maxEntries ?? 5000;
  const maxDepth = options.maxDepth ?? 12;
  const maxMatches = options.maxMatches ?? 20;
  const queue: Array<{ directory: string; depth: number }> = [
    { directory: path.posix.normalize(searchRoot), depth: 0 }
  ];
  const matches: string[] = [];
  let scanned = 0;
  while (queue.length > 0) {
    if (options.cancelled?.()) return { matches, truncated: true };
    const depth = queue[0].depth;
    const depthBoundary = queue.findIndex((item) => item.depth !== depth);
    const level = queue.splice(0, depthBoundary === -1 ? queue.length : depthBoundary);
    const nextLevel: Array<{ directory: string; depth: number }> = [];
    for (const current of level) {
      if (options.cancelled?.()) return { matches, truncated: true };
      const entries = (await readDirectory(current.directory)).filter(
        (entry) => entry.name && entry.name !== '.' && entry.name !== '..'
          && !/[\0/\\]/u.test(entry.name)
      ).sort((left, right) => {
        const hidden = Number(left.name.startsWith('.')) - Number(right.name.startsWith('.'));
        return hidden || left.name.localeCompare(right.name);
      });
      for (const entry of entries) {
        scanned++;
        if (scanned > maxEntries) return { matches, truncated: true };
        const candidatePath = path.posix.join(current.directory, entry.name);
        const relative = path.posix.relative(searchRoot, candidatePath);
        if (entry.type !== 'directory'
          && (relative === suffix || relative.endsWith(`/${suffix}`))) {
          matches.push(candidatePath);
          if (matches.length >= maxMatches) return { matches, truncated: true };
        }
        if (entry.type === 'directory' && current.depth < maxDepth) {
          nextLevel.push({ directory: candidatePath, depth: current.depth + 1 });
        }
      }
    }
    // Prefer the closest matches. Once the complete current depth has been
    // checked there is no reason to traverse potentially huge deeper trees.
    if (matches.length > 0) return { matches, truncated: false };
    queue.push(...nextLevel);
  }
  return { matches, truncated: false };
}
