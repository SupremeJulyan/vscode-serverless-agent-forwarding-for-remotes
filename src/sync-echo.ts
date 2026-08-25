export interface LocalFileFingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isDirectory(): boolean;
}

interface DownloadFingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  directory: boolean;
  expiresAt: number;
}

/**
 * Keeps a downloaded file's fingerprint long enough to absorb the burst of
 * create/change events emitted by VS Code's watcher for a single atomic write.
 */
export class DownloadEchoGuard {
  private readonly fingerprints = new Map<string, DownloadFingerprint>();

  constructor(
    private readonly ttlMs = 10_000,
    private readonly now: () => number = Date.now
  ) {}

  record(localPath: string, stat: LocalFileFingerprint): void {
    this.fingerprints.set(localPath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      directory: stat.isDirectory(),
      expiresAt: this.now() + this.ttlMs
    });
  }

  matches(localPath: string, stat: LocalFileFingerprint): boolean {
    const expected = this.fingerprints.get(localPath);
    if (!expected) return false;
    if (expected.expiresAt < this.now()) {
      this.fingerprints.delete(localPath);
      return false;
    }
    const matches = expected.size === stat.size
      && expected.mtimeMs === stat.mtimeMs
      && expected.ctimeMs === stat.ctimeMs
      && expected.directory === stat.isDirectory();
    if (!matches) this.fingerprints.delete(localPath);
    return matches;
  }

  forget(localPath: string): void {
    this.fingerprints.delete(localPath);
  }
}
