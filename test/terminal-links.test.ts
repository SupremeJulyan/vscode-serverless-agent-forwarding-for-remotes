import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findRemotePathCandidates, findRemoteTerminalPaths, resolveRemoteTerminalPath
} from '../src/terminal-links';

test('finds absolute and relative compiler paths with locations', () => {
  assert.deepEqual(
    findRemoteTerminalPaths('error at /srv/project/src/main.ts:12:7 and ./test/a.test.ts:4'),
    [
      { startIndex: 9, length: 29, path: '/srv/project/src/main.ts', line: 12, column: 7 },
      { startIndex: 43, length: 18, path: './test/a.test.ts', line: 4 }
    ]
  );
});

test('supports quoted paths containing spaces and trims surrounding punctuation', () => {
  const line = `at ("/srv/My Project/main file.ts":9:2), then [src/other.ts:3]`;
  const matches = findRemoteTerminalPaths(line);
  assert.deepEqual(matches.map(({ path, line: row, column }) => ({ path, row, column })), [
    { path: '/srv/My Project/main file.ts', row: 9, column: 2 },
    { path: 'src/other.ts', row: 3, column: undefined }
  ]);
});

test('trims the diagnostic separator after a line and column', () => {
  assert.deepEqual(findRemoteTerminalPaths('/srv/main.c:8:4: error: failed'), [
    { startIndex: 0, length: 15, path: '/srv/main.c', line: 8, column: 4 }
  ]);
});

test('ignores web URLs and ordinary words', () => {
  assert.deepEqual(
    findRemoteTerminalPaths('See https://example.com/a.ts:12 and version 1.2.3'),
    []
  );
});

test('resolves paths against the remote terminal cwd', () => {
  assert.equal(
    resolveRemoteTerminalPath('../shared/a.ts', '/srv/project/src'),
    '/srv/project/shared/a.ts'
  );
  assert.equal(resolveRemoteTerminalPath('/etc/hosts', '/srv/project'), '/etc/hosts');
  assert.throws(() => resolveRemoteTerminalPath('a.ts', 'relative/cwd'), /must be absolute/);
});

test('finds a basename omitted by a subdirectory listing without leaving the workspace', async () => {
  const directories = new Map<string, Array<{ name: string; type: string }>>([
    ['/workspace', [
      { name: 'batch_1', type: 'directory' },
      { name: 'batch_2', type: 'directory' }
    ]],
    ['/workspace/batch_1', [
      { name: '第一批应用测试记录-朱源.md', type: 'file' }
    ]],
    ['/workspace/batch_2', [{ name: 'other.md', type: 'file' }]]
  ]);
  const result = await findRemotePathCandidates(
    '/workspace', '第一批应用测试记录-朱源.md',
    async (directory) => directories.get(directory) ?? []
  );
  assert.deepEqual(result, {
    matches: ['/workspace/batch_1/第一批应用测试记录-朱源.md'],
    truncated: false
  });
});

test('refuses absolute and parent-traversing fallback searches', async () => {
  let reads = 0;
  const readDirectory = async () => {
    reads++;
    return [];
  };
  assert.deepEqual(
    await findRemotePathCandidates('/workspace', '/etc/passwd', readDirectory),
    { matches: [], truncated: false }
  );
  assert.deepEqual(
    await findRemotePathCandidates('/workspace', '../secret.txt', readDirectory),
    { matches: [], truncated: false }
  );
  assert.equal(reads, 0);
});

test('bounds recursive fallback searches', async () => {
  const result = await findRemotePathCandidates(
    '/workspace', 'missing.md',
    async (directory) => directory === '/workspace'
      ? [
        { name: 'a', type: 'directory' },
        { name: 'b', type: 'directory' },
        { name: 'c', type: 'directory' }
      ]
      : [],
    { maxEntries: 2 }
  );
  assert.deepEqual(result, { matches: [], truncated: true });
});

test('stops below the nearest matching depth and keeps same-depth choices', async () => {
  const reads: string[] = [];
  const entries = new Map<string, Array<{ name: string; type: string }>>([
    ['/workspace', [
      { name: 'a', type: 'directory' },
      { name: 'b', type: 'directory' }
    ]],
    ['/workspace/a', [
      { name: 'target.md', type: 'file' },
      { name: 'deep', type: 'directory' }
    ]],
    ['/workspace/b', [{ name: 'target.md', type: 'file' }]],
    ['/workspace/a/deep', [{ name: 'target.md', type: 'file' }]]
  ]);
  const result = await findRemotePathCandidates(
    '/workspace', 'target.md', async (directory) => {
      reads.push(directory);
      return entries.get(directory) ?? [];
    }
  );
  assert.deepEqual(result, {
    matches: ['/workspace/a/target.md', '/workspace/b/target.md'],
    truncated: false
  });
  assert.equal(reads.includes('/workspace/a/deep'), false);
});
