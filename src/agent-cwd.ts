import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir, symlink } from 'node:fs/promises';

export interface AgentCwdPlaceholder {
  localPath: string;
  linkPath?: string;
  targetPath?: string;
  created: boolean;
}

function nativeAbsoluteRemotePath(remoteRoot: string): string {
  if (!path.posix.isAbsolute(remoteRoot)) {
    throw new Error(`Agent cwd requires an absolute remote path: ${remoteRoot}`);
  }
  return path.resolve(remoteRoot);
}

async function exists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function pathPrefixes(absolutePath: string): string[] {
  const parsed = path.parse(absolutePath);
  const relative = absolutePath.slice(parsed.root.length);
  const segments = relative.split(path.sep).filter(Boolean);
  const prefixes: string[] = [];
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    prefixes.push(current);
  }
  return prefixes;
}

/**
 * Makes a virtual POSIX workspace path valid for native Agent startup without
 * copying remote files locally. The first missing native path component is a
 * junction on Windows and a directory symlink on POSIX; its backing directory
 * lives under VS Code's per-user extension storage.
 */
export async function ensureAgentCwdPlaceholder(
  remoteRoot: string, storageRoot: string
): Promise<AgentCwdPlaceholder> {
  const localPath = nativeAbsoluteRemotePath(remoteRoot);
  const parsed = path.parse(localPath);
  if (localPath === parsed.root) {
    return { localPath, created: false };
  }

  let linkPath: string | undefined;
  for (const prefix of pathPrefixes(localPath)) {
    if (!await exists(prefix)) {
      linkPath = prefix;
      break;
    }
  }
  if (!linkPath) return { localPath, created: false };

  const key = createHash('sha256').update(linkPath).digest('hex').slice(0, 16);
  const targetPath = path.join(storageRoot, 'agent-cwd', key);
  const remainder = path.relative(linkPath, localPath);
  await mkdir(path.join(targetPath, remainder), { recursive: true });
  await mkdir(path.dirname(linkPath), { recursive: true });
  try {
    await symlink(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return { localPath, linkPath, targetPath, created: true };
  } catch (error) {
    // Another window may have created the same link between lstat and symlink.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && await exists(localPath)) {
      return { localPath, linkPath, targetPath, created: false };
    }
    throw error;
  }
}
