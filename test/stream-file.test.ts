import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import * as os from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import { pipeStreams, writeStreamToFile } from '../src/stream-file';

test('streams a source into a file and reports deltas that sum to the total', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-stream-'));
  const target = path.join(directory, 'out.bin');
  const chunks = [
    Buffer.alloc(3 * 1024 * 1024, 0x61),
    Buffer.alloc(2 * 1024 * 1024, 0x62)
  ];
  const deltas: number[] = [];
  await writeStreamToFile(Readable.from(chunks), target, {
    onDelta: (delta) => deltas.push(delta)
  });
  const content = await readFile(target);
  assert.equal(content.length, 5 * 1024 * 1024);
  assert.equal(content[0], 0x61);
  assert.equal(content[3 * 1024 * 1024], 0x62);
  assert.equal(deltas.reduce((sum, delta) => sum + delta, 0), 5 * 1024 * 1024);
});

test('abort rejects and removes the partial file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-stream-'));
  const target = path.join(directory, 'partial.bin');
  const controller = new AbortController();
  const source = new Readable({
    read() {
      this.push(Buffer.alloc(1024 * 1024, 1));
      setTimeout(() => {
        if (this.destroyed) return;
        this.push(Buffer.alloc(1024 * 1024, 2));
        this.push(null);
      }, 50);
    }
  });
  const promise = writeStreamToFile(source, target, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, /传输已取消/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
});

test('creates parent directories before writing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-stream-'));
  const target = path.join(directory, 'nested', 'deep', 'file.txt');
  await writeStreamToFile(Readable.from([Buffer.from('hello')]), target);
  assert.equal(await readFile(target, 'utf8'), 'hello');
});

test('pipeStreams moves data between streams with delta reports', async () => {
  const chunks = [
    Buffer.alloc(3 * 1024 * 1024, 1),
    Buffer.alloc(2 * 1024 * 1024, 2)
  ];
  const target = new PassThrough();
  const received: Buffer[] = [];
  target.on('data', (chunk: Buffer) => received.push(chunk));
  const deltas: number[] = [];
  await pipeStreams(Readable.from(chunks), target, {
    onDelta: (delta) => deltas.push(delta)
  });
  const total = Buffer.concat(received);
  assert.equal(total.length, 5 * 1024 * 1024);
  assert.equal(total[0], 1);
  assert.equal(total[3 * 1024 * 1024], 2);
  assert.equal(deltas.reduce((sum, delta) => sum + delta, 0), 5 * 1024 * 1024);
});

test('pipeStreams abort destroys both ends and rejects', async () => {
  const controller = new AbortController();
  const target = new PassThrough();
  const source = new Readable({
    read() {
      this.push(Buffer.alloc(1024 * 1024, 1));
      setTimeout(() => {
        if (this.destroyed) return;
        this.push(Buffer.alloc(1024 * 1024, 2));
        this.push(null);
      }, 50);
    }
  });
  const promise = pipeStreams(source, target, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, /传输已取消/);
  assert.equal(source.destroyed, true);
  assert.equal(target.destroyed, true);
});

test('small transfers still report deltas (first emit + finish flush)', async () => {
  const deltas: number[] = [];
  const target = new PassThrough();
  target.resume();
  await pipeStreams(Readable.from([Buffer.from('tiny')]), target, {
    onDelta: (delta) => deltas.push(delta)
  });
  assert.equal(deltas.reduce((sum, delta) => sum + delta, 0), 4);
});
