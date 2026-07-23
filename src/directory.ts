import { readdir } from 'node:fs/promises';

export async function isEmptyDirectory(
  directory: string, missingIsEmpty = false
): Promise<boolean> {
  try {
    return (await readdir(directory)).length === 0;
  } catch (error) {
    return missingIsEmpty && (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}
