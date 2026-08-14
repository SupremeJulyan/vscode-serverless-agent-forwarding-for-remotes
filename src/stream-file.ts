import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import * as path from 'node:path';

export interface StreamPipeOptions {
  /** 每约 1MB 汇报一次增量字节（用于进度条）。 */
  onDelta?: (delta: number) => void;
  /** 取消信号：中止管道并销毁两端。 */
  signal?: AbortSignal;
}

/**
 * 把可读流分块写入可写流（边下边写，内存 O(chunk)）。
 *
 * - 任一端的 error 或 signal.abort 都会销毁对端并抛错（幂等，只 settle 一次）。
 * - onDelta 每约 1MB 汇报一次增量字节，供调用方驱动进度条。
 */
export async function pipeStreams(
  source: NodeJS.ReadableStream,
  target: NodeJS.WritableStream,
  options: StreamPipeOptions = {}
): Promise<void> {
  let received = 0;
  let lastReport = 0;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => options.signal?.removeEventListener('abort', aborted);
    const destroyBoth = () => {
      const destroyableSource = source as NodeJS.ReadableStream & { destroy?: () => void };
      destroyableSource.destroy?.();
      const destroyableTarget = target as NodeJS.WritableStream & { destroy?: () => void };
      destroyableTarget.destroy?.();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      destroyBoth();
      reject(error);
    };
    const aborted = () => fail(new Error('传输已取消'));
    options.signal?.addEventListener('abort', aborted, { once: true });
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received - lastReport >= 1024 * 1024) {
        options.onDelta?.(received - lastReport);
        lastReport = received;
      }
    });
    source.once('error', (error: Error) => fail(error));
    target.once('error', (error: Error) => fail(error));
    source.pipe(target);
    target.once('finish', () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (received > lastReport) options.onDelta?.(received - lastReport);
      resolve();
    });
  });
}

export interface WriteStreamOptions {
  /** 每约 1MB 汇报一次增量字节（用于进度条）。 */
  onDelta?: (delta: number) => void;
  /** 取消信号：中止写入并删除半成品文件。 */
  signal?: AbortSignal;
}

/**
 * 把可读流分块写入本地文件（边下边写，内存 O(chunk)，不整文件驻留内存）。
 *
 * - 失败或取消（signal.abort）时删除半成品文件并抛错，避免残留截断文件。
 * - onDelta 每约 1MB 汇报一次增量字节，供调用方驱动进度条。
 */
export async function writeStreamToFile(
  source: NodeJS.ReadableStream,
  target: string,
  options: WriteStreamOptions = {}
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await pipeStreams(source, createWriteStream(target, { flags: 'w' }), options);
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
}
