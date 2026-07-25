import path from 'node:path';

export function normalizeMountLockKey(localPath: string, caseInsensitive: boolean): string {
  const resolved = path.resolve(localPath);
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

export class MountOperationLock {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key);
    const token = {} as { tail: Promise<void> };
    const result = (async () => {
      await previous;
      try {
        return await action();
      } finally {
        if (this.tails.get(key) === token.tail) this.tails.delete(key);
      }
    })();
    token.tail = result.then(() => {}, () => {});
    this.tails.set(key, token.tail);
    return result;
  }
}
