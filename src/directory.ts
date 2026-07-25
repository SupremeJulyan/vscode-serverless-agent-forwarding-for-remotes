import { readdir } from 'node:fs/promises';
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

export async function isEmptyDirectoryTree(directory: string): Promise<boolean> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()
        || !await isEmptyDirectoryTree(path.join(directory, entry.name))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
