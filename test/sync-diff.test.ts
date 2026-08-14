import assert from 'node:assert/strict';
import test from 'node:test';
import { SftpSession } from '../src/sftp/session';
import { diffFingerprints, linesToMap, scanRemote } from '../src/sync-diff';

interface FakeNode {
  type: 'file' | 'directory';
  size: number;
  mtime: number;
}

/** 基于"绝对远程路径 → 节点"映射的假 SftpSession（仅实现扫描所需的方法）。 */
function fakeSession(nodes: Record<string, FakeNode>): SftpSession {
  const session = {
    hostName: 'fake',
    isAlive: () => true,
    stat: async (remotePath: string) => {
      const node = nodes[remotePath];
      if (!node) throw new Error(`ENOENT: ${remotePath}`);
      return { type: node.type, size: node.size, mtime: node.mtime, ctime: node.mtime };
    },
    readDirectory: async (remotePath: string) => {
      const prefix = remotePath === '/' ? '/' : `${remotePath}/`;
      const children = Object.keys(nodes).filter((key) =>
        key.startsWith(prefix) && !key.slice(prefix.length).includes('/')
      );
      return children.map((key) => ({
        name: key.slice(prefix.length),
        type: nodes[key].type,
        size: nodes[key].size,
        mtime: nodes[key].mtime,
        ctime: nodes[key].mtime
      }));
    }
  } as unknown as SftpSession;
  return session;
}

function line(rel: string, type: 'f' | 'd', sizeOrMtime: number, mtime?: number): string {
  return type === 'd' ? `d:${rel}:${sizeOrMtime}` : `f:${rel}:${sizeOrMtime}:${mtime ?? 0}`;
}

test('scanRemote fingerprints a file root and a directory tree', async () => {
  const fileSession = fakeSession({ '/srv/x': { type: 'file', size: 42, mtime: 10 } });
  assert.deepEqual(await scanRemote(fileSession, '/srv/x'), ['f::42:10']);

  const tree = fakeSession({
    '/srv/p': { type: 'directory', size: 0, mtime: 1 },
    '/srv/p/a.txt': { type: 'file', size: 5, mtime: 2 },
    '/srv/p/sub': { type: 'directory', size: 0, mtime: 3 },
    '/srv/p/sub/b.txt': { type: 'file', size: 7, mtime: 4 }
  });
  assert.deepEqual(await scanRemote(tree, '/srv/p'), [
    line('a.txt', 'f', 5, 2),
    line('sub', 'd', 3),
    line('sub/b.txt', 'f', 7, 4)
  ]);
});

test('diffFingerprints reports adds, removes and content changes', () => {
  const previous = linesToMap([
    line('a.txt', 'f', 5, 2),
    line('gone.txt', 'f', 9, 9),
    line('dir', 'd', 3)
  ]);
  const current = linesToMap([
    line('a.txt', 'f', 6, 5),       // 内容变化（size/mtime）
    line('new.txt', 'f', 1, 1),     // 新增
    line('dir', 'd', 3)             // 未变化
  ]);
  const diff = diffFingerprints(current, previous);
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.remove, ['gone.txt']);
  assert.deepEqual([...diff.create.keys()].sort(), ['a.txt', 'new.txt']);
});

test('diffFingerprints treats file<->dir type swaps as remove-then-create', () => {
  const previous = linesToMap([line('node', 'd', 3)]);
  const current = linesToMap([line('node', 'f', 100, 7)]);
  const diff = diffFingerprints(current, previous);
  assert.deepEqual(diff.remove, ['node']);
  assert.deepEqual([...diff.create.keys()], ['node']);
  assert.equal(diff.create.get('node')![0], 'f');

  const reverse = diffFingerprints(previous, current);
  assert.deepEqual(reverse.remove, ['node']);
  assert.equal(reverse.create.get('node')![0], 'd');
});

test('diffFingerprints reports no change for identical fingerprints', () => {
  const lines = [line('a.txt', 'f', 5, 2), line('dir', 'd', 3)];
  const diff = diffFingerprints(linesToMap(lines), linesToMap(lines));
  assert.equal(diff.changed, false);
  assert.deepEqual(diff.remove, []);
  assert.equal(diff.create.size, 0);
});
