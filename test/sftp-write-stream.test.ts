import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { Client, SFTPWrapper } from 'ssh2';
import { Ssh2SftpSession } from '../src/sftp/client';

function fakeClient(): Client {
  return { on: () => fakeClient() } as unknown as Client;
}

function makeSession(sftp: Partial<SFTPWrapper>): Ssh2SftpSession {
  return new Ssh2SftpSession('dev', fakeClient(), sftp as unknown as SFTPWrapper);
}

test('writeFileStream writes chunks with advancing offsets and closes the handle', async () => {
  const writes: Array<{ position: number; data: Buffer }> = [];
  let closed = 0;
  const sftp: Partial<SFTPWrapper> = {
    open: (_path, _flag, callback) => callback(undefined, Buffer.from('h1')),
    write: (_handle, buffer, offset, length, position, callback) => {
      writes.push({ position, data: Buffer.from(buffer.subarray(offset, offset + length)) });
      callback();
    },
    close: (_handle, callback) => {
      closed += 1;
      callback();
    }
  };
  const session = makeSession(sftp);
  const stream = await session.writeFileStream('/x', { create: true, overwrite: true });
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.once('finish', resolve);
    Readable.from([Buffer.from('aaa'), Buffer.from('bbb')]).pipe(stream);
  });
  assert.deepEqual(writes.map((write) => write.position), [0, 3]);
  assert.equal(Buffer.concat(writes.map((write) => write.data)).toString(), 'aaabbb');
  assert.equal(closed, 1);
});

test('writeFileStream rejects when open fails', async () => {
  const sftp: Partial<SFTPWrapper> = {
    open: (_path, _flag, callback) => callback(new Error('EEXIST'))
  };
  const session = makeSession(sftp);
  await assert.rejects(
    session.writeFileStream('/x', { create: true, overwrite: false }),
    /EEXIST/
  );
});

test('writeFileStream surfaces a write error', async () => {
  const sftp: Partial<SFTPWrapper> = {
    open: (_path, _flag, callback) => callback(undefined, Buffer.from('h')),
    write: (_handle, _buffer, _offset, _length, _position, callback) => callback(new Error('磁盘已满')),
    close: (_handle, callback) => callback()
  };
  const session = makeSession(sftp);
  const stream = await session.writeFileStream('/x', { create: true, overwrite: true });
  await assert.rejects(new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.once('finish', resolve);
    stream.end(Buffer.from('data'));
  }), /磁盘已满/);
});

test('writeFileStream abort destroys the stream and closes the handle', async () => {
  let closed = 0;
  const controller = new AbortController();
  const sftp: Partial<SFTPWrapper> = {
    open: (_path, _flag, callback) => callback(undefined, Buffer.from('h')),
    // 写不确认：等待 abort 触发 destroy。
    write: () => undefined,
    close: (_handle, callback) => {
      closed += 1;
      callback();
    }
  };
  const session = makeSession(sftp);
  const stream = await session.writeFileStream(
    '/x', { create: true, overwrite: true }, controller.signal
  );
  const errored = new Promise<Error>((resolve) => stream.once('error', resolve));
  stream.write(Buffer.from('data'));
  setTimeout(() => controller.abort(), 10);
  const error = await errored;
  assert.equal((error as Error & { name?: string }).name, 'AbortError');
  assert.equal(closed, 1);
});
