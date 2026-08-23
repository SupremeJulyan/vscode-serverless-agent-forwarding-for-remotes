import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function keyFor(mountName: string, remotePath: string): string {
  return createHash('sha256').update(mountName).update('\0').update(remotePath)
    .digest('hex').slice(0, 24);
}

export class SyncCoordinator {
  private readonly token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  private readonly owned = new Set<string>();

  constructor(private readonly root: string) {}

  private paths(mountName: string, remotePath: string): { lock: string; stopped: string } {
    const key = keyFor(mountName, remotePath);
    return {
      lock: path.join(this.root, `${key}.lock`),
      stopped: path.join(this.root, `${key}.stopped`)
    };
  }

  private readyPath(mountName: string, remotePath: string, localDir: string): string {
    const key = createHash('sha256')
      .update(mountName).update('\0').update(remotePath).update('\0').update(path.resolve(localDir))
      .digest('hex').slice(0, 24);
    return path.join(this.root, `${key}.ready`);
  }

  async acquire(mountName: string, remotePath: string): Promise<boolean> {
    await fs.mkdir(this.root, { recursive: true });
    const { lock } = this.paths(mountName, remotePath);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.writeFile(lock, `${this.token}\n`, { flag: 'wx', mode: 0o600 });
        this.owned.add(lock);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = await fs.readFile(lock, 'utf8').catch(() => '');
        const pid = Number(owner.split('-', 1)[0]);
        let alive = Number.isInteger(pid) && pid > 0;
        if (alive) {
          try { process.kill(pid, 0); } catch { alive = false; }
        }
        if (alive) return false;
        await fs.rm(lock, { force: true });
      }
    }
    return false;
  }

  async markReady(mountName: string, remotePath: string, localDir: string): Promise<void> {
    const ready = this.readyPath(mountName, remotePath, localDir);
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(ready, `${Date.now()}\n`, { mode: 0o600 });
  }

  async isReady(mountName: string, remotePath: string, localDir: string): Promise<boolean> {
    try {
      await fs.access(this.readyPath(mountName, remotePath, localDir));
      return true;
    } catch {
      return false;
    }
  }

  async clearReady(mountName: string, remotePath: string, localDir: string): Promise<void> {
    await fs.rm(this.readyPath(mountName, remotePath, localDir), { force: true });
  }

  async requestStop(mountName: string, remotePath: string): Promise<void> {
    const { stopped } = this.paths(mountName, remotePath);
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(stopped, `${Date.now()}\n`, { mode: 0o600 });
  }

  async clearStop(mountName: string, remotePath: string): Promise<void> {
    await fs.rm(this.paths(mountName, remotePath).stopped, { force: true });
  }

  async isStopRequested(mountName: string, remotePath: string): Promise<boolean> {
    try {
      await fs.access(this.paths(mountName, remotePath).stopped);
      return true;
    } catch {
      return false;
    }
  }

  async release(mountName: string, remotePath: string): Promise<void> {
    const { lock } = this.paths(mountName, remotePath);
    if (!this.owned.delete(lock)) return;
    const owner = await fs.readFile(lock, 'utf8').catch(() => '');
    if (owner.trim() === this.token) await fs.rm(lock, { force: true });
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.owned].map(async (lock) => {
      const owner = await fs.readFile(lock, 'utf8').catch(() => '');
      if (owner.trim() === this.token) await fs.rm(lock, { force: true });
    }));
    this.owned.clear();
  }
}
