import assert from 'node:assert/strict';
import test from 'node:test';
import { TrailingOperationQueue } from '../src/trailing-operation-queue';

test('event arriving during an operation causes one trailing rerun', async () => {
  const queue = new TrailingOperationQueue();
  let runs = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const complete = new Promise<void>((resolve) => {
    const operation = async () => {
      runs++;
      if (runs === 1) {
        markStarted();
        await blocked;
      }
      else resolve();
    };
    queue.enqueue('file', operation);
    void started.then(() => {
      queue.enqueue('file', operation);
      queue.enqueue('file', operation);
      release();
    });
  });
  await complete;
  assert.equal(runs, 2);
});

test('queue reports errors and accepts a later event for the same key', async () => {
  let errors = 0;
  const queue = new TrailingOperationQueue(() => { errors++; });
  queue.enqueue('file', async () => { throw new Error('failed'); });
  await new Promise((resolve) => setImmediate(resolve));
  let reran = false;
  queue.enqueue('file', async () => { reran = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors, 1);
  assert.equal(reran, true);
});

test('enqueue reports new work and calls onIdle after trailing work', async () => {
  const queue = new TrailingOperationQueue();
  let idle = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  assert.equal(queue.enqueue('file', () => blocked, () => { idle = true; }), true);
  assert.equal(queue.enqueue('file', async () => undefined), false);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, true);
});
