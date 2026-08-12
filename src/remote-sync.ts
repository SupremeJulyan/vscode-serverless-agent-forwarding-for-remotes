import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SftpSession } from './sftp/session';

/**
 * 远程目录/文件 → 本地目录的自动同步。
 *
 * 每个任务（mountName + 远程路径 + 本地目标）以固定间隔扫描远程子树，
 * 通过“条目指纹行”比对差异：新增/修改的条目下载到本地，远程已删除的
 * 条目删除本地对应文件。扫描行存于任务内存/globalState，重载后可继续。
 */

export interface RemoteSyncTask {
  mountName: string;
  /** 绝对远程路径（文件或目录）。 */
  remotePath: string;
  /** 本地目标：文件任务为完整本地文件路径；目录任务为本地目录路径。 */
  localDir: string;
  /** 最近一次同步的条目指纹行（持久化以便重载后继续增量同步）。 */
  fingerprintLines?: string[];
}

/** 指纹行：`f:rel:size:mtime` 或 `d:rel:mtime`；单文件任务 rel 为空。 */

function taskKey(mountName: string, remotePath: string): string {
  return `${mountName}\0${remotePath}`;
}

/** 递归扫描远程子树，返回指纹行数组。 */
async function scanRemote(
  session: SftpSession, remotePath: string
): Promise<string[]> {
  const rootStat = await session.stat(remotePath);
  if (rootStat.type !== 'directory') {
    return [`f::${rootStat.size}:${rootStat.mtime}`];
  }
  const lines: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await session.readDirectory(dir);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.posix.join(dir, entry.name);
      const rel = path.posix.relative(remotePath, full);
      if (entry.type === 'directory') {
        lines.push(`d:${rel}:${entry.mtime}`);
        await walk(full);
      } else {
        lines.push(`f:${rel}:${entry.size}:${entry.mtime}`);
      }
    }
  };
  await walk(remotePath);
  return lines;
}

function linesToMap(lines: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lines) {
    // 格式: 类型:相对路径:...
    const rel = line.slice(2, line.indexOf(':', 2));
    map.set(rel, line);
  }
  return map;
}

/** 下载单个远程文件到本地完整路径。 */
async function downloadFile(
  session: SftpSession, remotePath: string, localTarget: string
): Promise<void> {
  await fs.mkdir(path.dirname(localTarget), { recursive: true });
  const content = Buffer.from(await session.readFile(remotePath));
  await fs.writeFile(localTarget, content);
}

/** 全量下载（首次同步/目录任务），不删除本地多余文件。 */
async function downloadAll(
  session: SftpSession, remotePath: string, localTarget: string
): Promise<void> {
  const stat = await session.stat(remotePath);
  if (stat.type === 'directory') {
    await fs.mkdir(localTarget, { recursive: true });
    const entries = await session.readDirectory(remotePath);
    for (const entry of entries) {
      await downloadAll(
        session,
        path.posix.join(remotePath, entry.name),
        path.join(localTarget, entry.name)
      );
    }
  } else {
    await downloadFile(session, remotePath, localTarget);
  }
}

export class RemoteSyncManager {
  private readonly tasks = new Map<string, RemoteSyncTask>();
  private readonly running = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly getSession: (mountName: string) => Promise<SftpSession>,
    private readonly intervalMs: number,
    private readonly log: (message: string) => void = () => undefined
  ) {}

  list(): RemoteSyncTask[] {
    return [...this.tasks.values()];
  }

  has(mountName: string, remotePath: string): boolean {
    return this.tasks.has(taskKey(mountName, remotePath));
  }

  /** 注册任务并启动定时器（不立即同步；调用方用 syncNow 触发首次同步）。 */
  add(task: RemoteSyncTask): void {
    this.tasks.set(taskKey(task.mountName, task.remotePath), task);
    this.ensureTimer();
  }

  remove(mountName: string, remotePath: string): void {
    this.tasks.delete(taskKey(mountName, remotePath));
    this.log(`已停止同步：${remotePath}`);
    if (this.tasks.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 立即同步指定任务（用于创建时）。 */
  async syncNow(mountName: string, remotePath: string): Promise<void> {
    const task = this.tasks.get(taskKey(mountName, remotePath));
    if (task) await this.pollTask(task);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  private async poll(): Promise<void> {
    for (const task of [...this.tasks.values()]) {
      await this.pollTask(task);
    }
  }

  private async pollTask(task: RemoteSyncTask): Promise<void> {
    const key = taskKey(task.mountName, task.remotePath);
    if (this.running.has(key)) return;
    this.running.add(key);
    try {
      const session = await this.getSession(task.mountName);
      const lines = await scanRemote(session, task.remotePath);
      const current = linesToMap(lines);
      const previous = task.fingerprintLines
        ? linesToMap(task.fingerprintLines)
        : undefined;
      if (previous) {
        // 增量：下载新增/修改，删除远程已消失的本地条目。
        let changed = false;
        for (const [rel, line] of current) {
          const oldLine = previous.get(rel);
          if (oldLine === line) continue;
          changed = true;
          const localFull = path.join(task.localDir, rel);
          if (line.startsWith('d:')) {
            await fs.mkdir(localFull, { recursive: true });
          } else {
            await downloadFile(session, path.posix.join(task.remotePath, rel), localFull);
          }
        }
        for (const rel of previous.keys()) {
          if (current.has(rel)) continue;
          changed = true;
          await fs.rm(path.join(task.localDir, rel), { recursive: true, force: true });
        }
        if (changed) {
          this.log(`同步完成: ${task.remotePath} -> ${task.localDir}（${lines.length} 项）`);
        }
      } else {
        // 首次同步：全量下载（不删除本地已有内容）。
        await downloadAll(session, task.remotePath, task.localDir);
        this.log(`首次同步完成: ${task.remotePath} -> ${task.localDir}（${lines.length} 项）`);
      }
      task.fingerprintLines = lines;
    } catch (error) {
      this.log(`同步失败: ${task.remotePath}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running.delete(key);
    }
  }
}
