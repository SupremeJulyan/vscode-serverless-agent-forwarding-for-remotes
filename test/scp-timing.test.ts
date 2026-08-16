import assert from 'node:assert/strict';
import test from 'node:test';

import { recordScpOperationTime } from '../src/scp-timing';

test('records SCP operation timings only for the SCP transport', async () => {
  const lines: string[] = [];

  const result = await recordScpOperationTime(
    '列出远程目录',
    async () => 'ok',
    { transport: 'scp', log: (message) => lines.push(message) }
  );

  assert.equal(result, 'ok');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[SCP 耗时\] 列出远程目录: \d+ms$/);

  await recordScpOperationTime(
    '打开远程文件',
    async () => 'sftp',
    { transport: 'sftp', log: (message) => lines.push(message) }
  );

  assert.equal(lines.length, 1);
});
