import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findRemoteTerminalPaths, resolveRemoteTerminalPath
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
