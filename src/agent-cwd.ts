import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';

export interface AgentCwdPlaceholder {
  localPath: string;
  created: boolean;
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

/**
 * Creates a real, user-writable directory for native Agents to use as cwd.
 * The SFTP provider maps this directory-shaped URI namespace to remoteRoot;
 * no directory or symlink is created at the remote machine's absolute path.
 */
export async function ensureAgentCwdPlaceholder(
  remoteRoot: string, storageRoot: string, mountName = ''
): Promise<AgentCwdPlaceholder> {
  if (!path.posix.isAbsolute(remoteRoot)) {
    throw new Error(`Agent cwd requires an absolute remote path: ${remoteRoot}`);
  }
  const key = createHash('sha256')
    .update(mountName).update('\0').update(path.posix.normalize(remoteRoot))
    .digest('hex').slice(0, 16);
  const localPath = path.join(storageRoot, 'agent-cwd', key, 'workspace');
  const created = !await exists(localPath);
  await mkdir(localPath, { recursive: true });
  return { localPath, created };
}

/** Creates the local empty directory that represents a remote workspace subdirectory. */
export async function ensureAgentCwdSubdirectory(
  localRoot: string, remoteRoot: string, remotePath: string
): Promise<string> {
  const relative = path.posix.relative(
    path.posix.normalize(remoteRoot), path.posix.normalize(remotePath)
  );
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new Error(`Agent cwd path is outside the remote root: ${remotePath}`);
  }
  const localPath = relative
    ? path.join(localRoot, ...relative.split('/'))
    : localRoot;
  await mkdir(localPath, { recursive: true });
  return localPath;
}
