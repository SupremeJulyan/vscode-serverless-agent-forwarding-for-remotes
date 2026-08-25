import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteRemoteTree, ensureRemoteDir } from '../src/remote-tree';
import { SftpSession } from '../src/sftp/session';

function fakeSession(entries: Record<string, 'file' | 'directory'>): {
  session: SftpSession;
  deleted: string[];
  created: string[];
} {
  const deleted: string[] = [];
  const created: string[] = [];
  const session = {
    stat: async (remotePath: string) => {
      const type = entries[remotePath];
      if (!type) {
        const error = new Error('missing') as Error & { code: number };
        error.code = 2;
        throw error;
      }
      return { type, size: 0, mtime: 0, ctime: 0, permissions: 0 };
    },
    readDirectory: async (remotePath: string) => Object.entries(entries)
      .filter(([candidate]) => candidate.startsWith(`${remotePath}/`)
        && !candidate.slice(remotePath.length + 1).includes('/'))
      .map(([candidate, type]) => ({
        name: candidate.slice(remotePath.length + 1), type,
        size: 0, mtime: 0, ctime: 0, permissions: 0
      })),
    deleteFile: async (remotePath: string) => { deleted.push(remotePath); delete entries[remotePath]; },
    deleteDirectory: async (remotePath: string) => { deleted.push(remotePath); delete entries[remotePath]; },
    createDirectory: async (remotePath: string) => { created.push(remotePath); entries[remotePath] = 'directory'; }
  } as unknown as SftpSession;
  return { session, deleted, created };
}

test('recursive remote delete removes children before their directories', async () => {
  const { session, deleted } = fakeSession({
    '/root': 'directory', '/root/a': 'directory', '/root/a/file': 'file', '/root/b': 'file'
  });
  await deleteRemoteTree(session, '/root');
  assert.deepEqual(deleted, ['/root/a/file', '/root/a', '/root/b', '/root']);
});

test('ensuring a remote directory replaces a file blocking the path', async () => {
  const { session, deleted, created } = fakeSession({ '/root': 'file' });
  await ensureRemoteDir(session, '/root/child');
  assert.deepEqual(deleted, ['/root']);
  assert.deepEqual(created, ['/root', '/root/child']);
});

test('remote tree helpers do not mistake connection errors for missing paths', async () => {
  const failed = new Error('connection reset') as Error & { code: string };
  failed.code = 'ECONNRESET';
  const session = { stat: async () => { throw failed; } } as unknown as SftpSession;
  await assert.rejects(deleteRemoteTree(session, '/root'), failed);
  await assert.rejects(ensureRemoteDir(session, '/root'), failed);
});
