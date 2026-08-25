import * as path from 'node:path';
import { SftpSession } from './sftp/session';

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: number | string } | undefined)?.code;
  return code === 2 || code === 'ENOENT';
}

/** Ensures every remote path component is a directory, replacing blocking files. */
export async function ensureRemoteDir(
  session: SftpSession, remoteDir: string
): Promise<void> {
  const parts = remoteDir.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    let stat;
    try {
      stat = await session.stat(current);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await session.createDirectory(current);
      continue;
    }
    if (stat.type !== 'directory') {
      await session.deleteFile(current);
      await session.createDirectory(current);
    }
  }
}

/** Recursively removes a remote path; SFTP rmdir itself only accepts empty directories. */
export async function deleteRemoteTree(session: SftpSession, remotePath: string): Promise<void> {
  let stat;
  try {
    stat = await session.stat(remotePath);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (stat.type !== 'directory') {
    await session.deleteFile(remotePath);
    return;
  }
  for (const entry of await session.readDirectory(remotePath)) {
    await deleteRemoteTree(session, path.posix.join(remotePath, entry.name));
  }
  await session.deleteDirectory(remotePath);
}
