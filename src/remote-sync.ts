import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isRemotePathInsideRoot } from './sftp/uri';
import { SftpSession } from './sftp/session';

/**
 * 远程目录/文件 ↔ 本地目录的双向自动同步（事件驱动，不轮询）。
 *
 * 远程 → 本地：VS Code 通过 SAFS 文件系统保存/删除/重命名/建目录时，
 * provider 回调 notifyRemoteChange，把变更同步到本地。
 * 本地 → 远程：监听本地目标目录的文件系统事件，把本地变更上传/删除到远程。
 * 通过 localDownloading / remoteUploading 防止回环。
 */

export interface RemoteSyncTask {
  mountName: string;
  /** 绝对远程路径（文件或目录）。 */
  remotePath: string;
  /** 本地目标：文件任务为完整本地文件路径；目录任务为本地目录路径。 */
  localDir: string;
  /** 是否为单文件任务（由首次扫描确定）。 */
  isFile?: boolean;
  /** 最近一次同步的条目指纹行（用于重载后增量补同步）。 */
  fingerprintLines?: string[];
}

export type RemoteMutationKind = 'write' | 'delete' | 'rename' | 'mkdir';

function taskKey(mountName: string, remotePath: string): string {
  return `${mountName}\0${remotePath}`;
}

function joinLocal(base: string, relativePosix: string): string {
  return relativePosix ? path.join(base, ...relativePosix.split('/')) : base;
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
    const rel = line.slice(2, line.indexOf(':', 2));
    map.set(rel, line);
  }
  return map;
}

/** 逐级确保远程目录存在（父目录缺失时创建）。 */
async function ensureRemoteDir(
  session: SftpSession, remoteDir: string
): Promise<void> {
  const parts = remoteDir.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    try {
      await session.stat(current);
    } catch {
      await session.createDirectory(current).catch(() => undefined);
    }
  }
}

export class RemoteSyncManager {
  private readonly tasks = new Map<string, RemoteSyncTask>();
  private readonly watchers = new Map<string, vscode.Disposable>();
  /** 正在由“远程→本地”写入的本地路径（本地 watcher 跳过，防回环）。 */
  private readonly localDownloading = new Set<string>();
  /** 正在由“本地→远程”上传的远程路径（provider 回调跳过）。 */
  private readonly remoteUploading = new Set<string>();

  constructor(
    private readonly getSession: (mountName: string) => Promise<SftpSession>,
    private readonly resolveRemote: (
      uri: vscode.Uri
    ) => { mountName: string; remotePath: string } | undefined,
    private readonly log: (message: string) => void = () => undefined,
    private readonly onTaskChanged: () => void = () => undefined
  ) {}

  list(): RemoteSyncTask[] {
    return [...this.tasks.values()];
  }

  has(mountName: string, remotePath: string): boolean {
    return this.tasks.has(taskKey(mountName, remotePath));
  }

  add(task: RemoteSyncTask): void {
    this.tasks.set(taskKey(task.mountName, task.remotePath), task);
    // 首次同步（增量基线），完成后启动本地 watcher（双向）并持久化。
    void this.baseline(task).then(() => {
      this.startLocalWatcher(task);
      this.onTaskChanged();
    });
    this.onTaskChanged();
  }

  remove(mountName: string, remotePath: string): void {
    const key = taskKey(mountName, remotePath);
    const task = this.tasks.get(key);
    if (task) {
      this.watchers.get(task.localDir)?.dispose();
      this.watchers.delete(task.localDir);
    }
    this.tasks.delete(key);
    this.log(`已停止同步：${remotePath}`);
    this.onTaskChanged();
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) watcher.dispose();
    this.watchers.clear();
  }

  /** provider 回调：远程发生写/删/重命名/建目录时同步到本地。 */
  async notifyRemoteChange(
    uri: vscode.Uri, kind: RemoteMutationKind, targetUri?: vscode.Uri
  ): Promise<void> {
    const resolved = this.resolveRemote(uri);
    if (!resolved) return;
    if (this.remoteUploading.has(resolved.remotePath)) return;
    for (const task of this.tasks.values()) {
      if (task.mountName !== resolved.mountName) continue;
      if (!isRemotePathInsideRoot(task.remotePath, resolved.remotePath)) continue;
      await this.applyRemoteChange(task, resolved.remotePath, kind, targetUri);
    }
  }

  // ── 远程 → 本地 ──────────────────────────────────────────────────────────

  private async applyRemoteChange(
    task: RemoteSyncTask, remotePath: string,
    kind: RemoteMutationKind, targetUri?: vscode.Uri
  ): Promise<void> {
    const rel = path.posix.relative(task.remotePath, remotePath);
    const localFull = joinLocal(task.localDir, rel);
    const session = await this.getSession(task.mountName);
    this.localDownloading.add(localFull);
    try {
      if (kind === 'write') {
        await fs.mkdir(path.dirname(localFull), { recursive: true });
        const content = Buffer.from(await session.readFile(remotePath));
        await fs.writeFile(localFull, content);
        this.log(`已同步到本地: ${remotePath} -> ${localFull}`);
      } else if (kind === 'mkdir') {
        await fs.mkdir(localFull, { recursive: true });
      } else if (kind === 'delete') {
        await fs.rm(localFull, { recursive: true, force: true });
        this.log(`已删除本地: ${localFull}`);
      } else if (kind === 'rename' && targetUri) {
        const target = this.resolveRemote(targetUri);
        if (!target) return;
        const relTarget = path.posix.relative(task.remotePath, target.remotePath);
        const localTarget = joinLocal(task.localDir, relTarget);
        await fs.mkdir(path.dirname(localTarget), { recursive: true });
        await fs.rename(localFull, localTarget).catch(() => undefined);
        this.log(`已重命名本地: ${localFull} -> ${localTarget}`);
      }
    } catch (error) {
      this.log(`同步到本地失败: ${remotePath}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.localDownloading.delete(localFull);
    }
  }

  /** 首次/恢复时的增量基线同步（一次，非轮询）。 */
  private async baseline(task: RemoteSyncTask): Promise<void> {
    try {
      const session = await this.getSession(task.mountName);
      const lines = await scanRemote(session, task.remotePath);
      task.isFile = lines.length === 1 && lines[0].startsWith('f::');
      if (!task.fingerprintLines) {
        await this.downloadTree(session, task.remotePath, task.localDir, task.isFile);
        this.log(`首次同步完成: ${task.remotePath} -> ${task.localDir}（${lines.length} 项）`);
      } else {
        const current = linesToMap(lines);
        const previous = linesToMap(task.fingerprintLines);
        let changed = false;
        for (const [rel, line] of current) {
          if (previous.get(rel) === line) continue;
          changed = true;
          const localFull = joinLocal(task.localDir, rel);
          if (line.startsWith('d:')) {
            await fs.mkdir(localFull, { recursive: true });
          } else {
            await this.downloadOne(session, path.posix.join(task.remotePath, rel), localFull);
          }
        }
        for (const rel of previous.keys()) {
          if (current.has(rel)) continue;
          changed = true;
          await fs.rm(joinLocal(task.localDir, rel), { recursive: true, force: true });
        }
        if (changed) {
          this.log(`同步基线更新: ${task.remotePath} -> ${task.localDir}（${lines.length} 项）`);
        }
      }
      task.fingerprintLines = lines;
    } catch (error) {
      this.log(`同步基线失败: ${task.remotePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async downloadOne(
    session: SftpSession, remotePath: string, localFull: string
  ): Promise<void> {
    this.localDownloading.add(localFull);
    try {
      await fs.mkdir(path.dirname(localFull), { recursive: true });
      const content = Buffer.from(await session.readFile(remotePath));
      await fs.writeFile(localFull, content);
    } finally {
      this.localDownloading.delete(localFull);
    }
  }

  private async downloadTree(
    session: SftpSession, remotePath: string, localTarget: string, isFile?: boolean
  ): Promise<void> {
    if (isFile) {
      await this.downloadOne(session, remotePath, localTarget);
      return;
    }
    const stat = await session.stat(remotePath);
    if (stat.type === 'directory') {
      this.localDownloading.add(localTarget);
      try {
        await fs.mkdir(localTarget, { recursive: true });
      } finally {
        this.localDownloading.delete(localTarget);
      }
      const entries = await session.readDirectory(remotePath);
      for (const entry of entries) {
        await this.downloadTree(
          session,
          path.posix.join(remotePath, entry.name),
          path.join(localTarget, entry.name),
          entry.type !== 'directory'
        );
      }
    } else {
      await this.downloadOne(session, remotePath, localTarget);
    }
  }

  // ── 本地 → 远程 ──────────────────────────────────────────────────────────

  private startLocalWatcher(task: RemoteSyncTask): void {
    if (task.isFile === undefined || this.watchers.has(task.localDir)) return;
    const dir = task.isFile ? path.dirname(task.localDir) : task.localDir;
    const pattern = task.isFile
      ? new vscode.RelativePattern(dir, path.basename(task.localDir))
      : new vscode.RelativePattern(dir, '**/*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate((uri) => void this.onLocalCreated(task, uri));
    watcher.onDidChange((uri) => void this.onLocalChanged(task, uri));
    watcher.onDidDelete((uri) => void this.onLocalDeleted(task, uri));
    this.watchers.set(task.localDir, watcher);
  }

  private remoteTargetFor(task: RemoteSyncTask, localPath: string): string {
    const rel = path.relative(task.localDir, localPath);
    return rel ? path.posix.join(task.remotePath, rel.split(path.sep).join('/')) : task.remotePath;
  }

  private async onLocalCreated(task: RemoteSyncTask, uri: vscode.Uri): Promise<void> {
    const localPath = uri.fsPath;
    if (this.localDownloading.has(localPath)) return;
    const remoteFull = this.remoteTargetFor(task, localPath);
    if (this.remoteUploading.has(remoteFull)) return;
    const session = await this.getSession(task.mountName);
    this.remoteUploading.add(remoteFull);
    try {
      const stat = await fs.stat(localPath);
      if (stat.isDirectory()) {
        await ensureRemoteDir(session, remoteFull);
      } else {
        await ensureRemoteDir(session, path.posix.dirname(remoteFull));
        const content = await fs.readFile(localPath);
        await session.writeFile(remoteFull, new Uint8Array(content), { create: true, overwrite: true });
      }
      this.log(`已上传: ${localPath} -> ${remoteFull}`);
    } catch (error) {
      this.log(`上传失败: ${localPath}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.remoteUploading.delete(remoteFull);
    }
  }

  private async onLocalChanged(task: RemoteSyncTask, uri: vscode.Uri): Promise<void> {
    await this.onLocalCreated(task, uri);
  }

  private async onLocalDeleted(task: RemoteSyncTask, uri: vscode.Uri): Promise<void> {
    const localPath = uri.fsPath;
    if (this.localDownloading.has(localPath)) return;
    const remoteFull = this.remoteTargetFor(task, localPath);
    if (this.remoteUploading.has(remoteFull)) return;
    const session = await this.getSession(task.mountName);
    try {
      await session.deleteFile(remoteFull).catch(() => session.deleteDirectory(remoteFull));
      this.log(`已删除远程: ${remoteFull}`);
    } catch (error) {
      this.log(`删除远程失败: ${remoteFull}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
