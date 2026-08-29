import { lstat } from 'node:fs/promises';
import * as path from 'node:path';

export function localPathForRemote(base: string, relativePosix: string): string {
  const root = path.resolve(base);
  const candidate = relativePosix
    ? path.resolve(root, ...relativePosix.split('/'))
    : root;
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Remote path escapes the local sync root: ${relativePosix}`);
  }
  return candidate;
}

/** Reject links inside a sync tree before any read, write, rename, or delete. */
export async function assertLocalSyncPath(
  root: string, candidate: string, allowLeafSymlink = false
): Promise<void> {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Local path escapes the sync root: ${candidate}`);
  }
  const parts = relative.split(path.sep).filter(Boolean);
  let current = normalizedRoot;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    try {
      const stat = await lstat(current);
      const leaf = index === parts.length - 1;
      if (stat.isSymbolicLink() && !(allowLeafSymlink && leaf)) {
        throw new Error(`Symbolic links are not supported in sync trees: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}
