import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import { parseWslUncPath, readTextFile, writeTextFile } from '../src/wsl-file';

test('parseWslUncPath maps wsl.localhost UNC to distro and linux path', () => {
  assert.deepEqual(parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\user'), {
    distro: 'Ubuntu', linuxPath: '/home/user'
  });
  assert.deepEqual(parseWslUncPath('\\\\wsl.localhost\\AgentOS\\root'), {
    distro: 'AgentOS', linuxPath: '/root'
  });
  assert.deepEqual(parseWslUncPath('\\\\WSL.LOCALHOST\\Ubuntu\\home\\a'), {
    distro: 'Ubuntu', linuxPath: '/home/a'
  });
  assert.deepEqual(
    parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\user\\.pi\\agent\\mcp.json'),
    { distro: 'Ubuntu', linuxPath: '/home/user/.pi/agent/mcp.json' }
  );
});

test('parseWslUncPath returns undefined for non-UNC paths', () => {
  assert.equal(parseWslUncPath('C:\\Users\\admin'), undefined);
  assert.equal(parseWslUncPath('/home/user'), undefined);
  assert.equal(parseWslUncPath('\\\\server\\share\\x'), undefined);
});

test('readTextFile / writeTextFile work on local paths (non-UNC branch)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-wsl-file-'));
  const target = path.join(directory, 'sub', 'file.txt');
  await writeTextFile(target, 'hello\n', 0o600);
  assert.equal(await readTextFile(target), 'hello\n');
  const content = await readFile(target, 'utf8');
  assert.equal(content, 'hello\n');
});
