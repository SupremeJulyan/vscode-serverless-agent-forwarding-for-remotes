import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

export async function isEmptyDirectory(
  directory: string, missingIsEmpty = false
): Promise<boolean> {
  try {
    return (await readdir(directory)).length === 0;
  } catch (error) {
    return missingIsEmpty && (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export async function isEmptyDirectoryTree(
  directory: string, seen = new Set<number>()
): Promise<boolean> {
  try {
    let fileStat;
    try {
      fileStat = await stat(directory);
    } catch {
      return false;
    }
    if (seen.has(fileStat.ino)) return true;
    seen.add(fileStat.ino);

    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()
        || !await isEmptyDirectoryTree(path.join(directory, entry.name), seen)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
