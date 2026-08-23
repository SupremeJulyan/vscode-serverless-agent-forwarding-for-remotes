import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isRemotePathInsideRoot } from './sftp/uri';
import { SftpSession } from './sftp/session';
import { diffFingerprints, linesToMap, scanRemote } from './sync-diff';
import { writeStreamToFile } from './stream-file';

/**
 * 远程目录/文件 ↔ 本地目录的双向自动同步（事件驱动，不轮询）。
 *
 * 远程 → 本地：VS Code 通过 SAFS 文件系统保存/删除/重命名/建目录时，
 * provider 回调 notifyRemoteChange，把变更同步到本地。
 * 本地 → 远程：监听本地目标目录的文件系统事件，把本地变更上传/删除到远程。
 *
 * 一致性设计：
 * - 同一本地路径的本地操作（创建/修改/删除）按 (task, localPath) 串行排队，
 *   执行时按文件最新状态决定上传或删除远端（尾沿合并，事件不丢弃）。
 * - 下载在覆盖本地前比对下载窗口前后的 mtime：期间被本地修改/删除则跳过
 *   覆盖，避免"下载在途时本地编辑被远端内容覆盖"。
 * - 基线失败进入指数退避重试，本地 watcher 仅在基线成功后启动，避免半初始化
 *   镜像反向污染远端。
 * - 指纹 diff 对 file↔dir 类型互换先删后建。
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

/** 逐级确保远程目录存在（父目录缺失时创建）。供同步与可视化上传共用。 */
export async function ensureRemoteDir(
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

const baselineRetryBaseMs = 1_000;
const baselineRetryCapMs = 30_000;

export class RemoteSyncManager {
  private readonly tasks = new Map<string, RemoteSyncTask>();
  /** 已完成首次/恢复基线、可以安全打开本地镜像的任务。 */
  private readonly readyTasks = new Set<string>();
  /** localDir → watcher 与共享该 watcher 的任务 key 集合（引用计数共享）。 */
  private readonly watchers = new Map<string, {
    watcher: vscode.Disposable;
    taskKeys: Set<string>;
  }>();
  /** 正在由"远程→本地"写入的本地路径（本地 watcher 跳过，防回环）。 */
  private readonly localDownloading = new Set<string>();
  /** 正在由"本地→远程"上传的远程路径（provider 回调跳过）。 */
  private readonly remoteUploading = new Set<string>();
  /** 本地路径 → 进行中的下载 promise（本地操作等待其完成，避免交错/回环）。 */
  private readonly activeDownloads = new Map<string, Promise<void>>();
  /** 本地路径 → 最近一次下载写入后的 mtime（识别下载回写触发的 watcher echo）。 */
  private readonly downloadedMtimes = new Map<string, number>();
  /** (task,localPath) → 串行本地操作队列（尾沿合并）。 */
  private readonly localOpQueues = new Map<string, Promise<void>>();
  private readonly pendingLocalOps = new Set<string>();
  /** 基线失败后的退避重试定时器。 */
  private readonly baselineTimers = new Map<string, NodeJS.Timeout>();
  private readonly ownedTasks = new Set<string>();
  private readonly ownershipMonitors = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly getSession: (mountName: string) => Promise<SftpSession>,
    private readonly resolveRemote: (
      uri: vscode.Uri
    ) => { mountName: string; remotePath: string } | undefined,
    private readonly log: (message: string) => void = () => undefined,
    private readonly onTaskChanged: () => void = () => undefined,
    private readonly status: (message: string) => void = () => undefined,
    private readonly acquireTask: (task: RemoteSyncTask) => Promise<boolean> = async () => true,
    private readonly releaseTask: (task: RemoteSyncTask) => Promise<void> = async () => undefined,
    private readonly markTaskReady: (task: RemoteSyncTask) => Promise<void> = async () => undefined,
    private readonly isStopRequested: (task: RemoteSyncTask) => Promise<boolean> = async () => false
  ) {}

  list(): RemoteSyncTask[] {
    return [...this.tasks.values()];
  }

  has(mountName: string, remotePath: string): boolean {
    return this.tasks.has(taskKey(mountName, remotePath));
  }

  isReady(mountName: string, remotePath: string): boolean {
    return this.readyTasks.has(taskKey(mountName, remotePath));
  }

  add(task: RemoteSyncTask): void {
    const key = taskKey(task.mountName, task.remotePath);
    this.tasks.set(key, task);
    this.readyTasks.delete(key);
    this.onTaskChanged();
    void this.startTask(task);
  }

  private async startTask(task: RemoteSyncTask): Promise<void> {
    const key = taskKey(task.mountName, task.remotePath);
    if (!await this.acquireTask(task)) {
      this.log(`同步任务由另一个 VS Code 窗口管理：${task.remotePath}`);
      return;
    }
    if (this.tasks.get(key) !== task) {
      await this.releaseTask(task);
      return;
    }
    this.ownedTasks.add(key);
    const monitor = setInterval(() => {
      void this.isStopRequested(task).then((stopped) => {
        if (stopped && this.tasks.get(key) === task) this.remove(task.mountName, task.remotePath);
      });
    }, 1_000);
    monitor.unref?.();
    this.ownershipMonitors.set(key, monitor);
    await this.runBaseline(task, 0);
  }

  remove(mountName: string, remotePath: string): void {
    const key = taskKey(mountName, remotePath);
    const task = this.tasks.get(key);
    if (task) {
      const entry = this.watchers.get(task.localDir);
      if (entry) {
        entry.taskKeys.delete(key);
        if (entry.taskKeys.size === 0) {
          entry.watcher.dispose();
          this.watchers.delete(task.localDir);
        }
      }
      const retry = this.baselineTimers.get(key);
      if (retry) {
        clearTimeout(retry);
        this.baselineTimers.delete(key);
      }
      this.localOpQueues.delete(key);
    }
    this.tasks.delete(key);
    this.readyTasks.delete(key);
    const monitor = this.ownershipMonitors.get(key);
    if (monitor) clearInterval(monitor);
    this.ownershipMonitors.delete(key);
    if (this.ownedTasks.delete(key) && task) void this.releaseTask(task);
    this.log(`已停止同步：${remotePath}`);
    this.onTaskChanged();
  }

  dispose(): void {
    for (const timer of this.baselineTimers.values()) clearTimeout(timer);
    this.baselineTimers.clear();
    for (const entry of this.watchers.values()) entry.watcher.dispose();
    this.watchers.clear();
    for (const monitor of this.ownershipMonitors.values()) clearInterval(monitor);
    this.ownershipMonitors.clear();
    for (const key of this.ownedTasks) {
      const task = this.tasks.get(key);
      if (task) void this.releaseTask(task);
    }
    this.ownedTasks.clear();
  }

  /** provider 回调：远程发生写/删/重命名/建目录时同步到本地。 */
  async notifyRemoteChange(
    uri: vscode.Uri, kind: RemoteMutationKind, targetUri?: vscode.Uri
  ): Promise<void> {
    const resolved = this.resolveRemote(uri);
    if (!resolved) return;
    if (this.remoteUploading.has(resolved.remotePath)) return;
    const kindLabels: Record<RemoteMutationKind, string> = {
      write: '保存', delete: '删除', rename: '重命名', mkdir: '建目录'
    };
    this.status(`远程${kindLabels[kind]} → 本地`);
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
    try {
      if (kind === 'write') {
        const session = await this.getSession(task.mountName);
        await this.downloadOne(session, remotePath, localFull);
        this.log(`已同步到本地: ${remotePath} -> ${localFull}`);
      } else if (kind === 'mkdir') {
        await this.withDownload(localFull, async () => {
          await fs.mkdir(localFull, { recursive: true });
        });
      } else if (kind === 'delete') {
        await fs.rm(localFull, { recursive: true, force: true });
        this.log(`已删除本地: ${localFull}`);
      } else if (kind === 'rename' && targetUri) {
        const target = this.resolveRemote(targetUri);
        if (!target) return;
        const relTarget = path.posix.relative(task.remotePath, target.remotePath);
        if (relTarget === '..' || relTarget.startsWith('../')
          || path.posix.isAbsolute(relTarget)) {
          this.log(`跳过重命名（目标超出同步根）: ${target.remotePath}`);
          return;
        }
        const localTarget = joinLocal(task.localDir, relTarget);
        await fs.mkdir(path.dirname(localTarget), { recursive: true });
        await fs.rename(localFull, localTarget).catch(() => undefined);
        this.log(`已重命名本地: ${localFull} -> ${localTarget}`);
      }
    } catch (error) {
      this.log(`同步到本地失败: ${remotePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 首次/恢复时的增量基线同步。成功返回 true；失败返回 false（触发退避重试）。 */
  private async baseline(task: RemoteSyncTask): Promise<boolean> {
    this.status(`正在同步: ${task.remotePath} → ${task.localDir}`);
    try {
      const session = await this.getSession(task.mountName);
      const lines = await scanRemote(session, task.remotePath);
      const isFile = lines.length === 1 && lines[0].startsWith('f::');
      if (!task.fingerprintLines) {
        await this.downloadTree(session, task.remotePath, task.localDir, isFile);
        this.log(`首次同步完成: ${task.remotePath} -> ${task.localDir}（${lines.length} 项）`);
      } else {
        const current = linesToMap(lines);
        const previous = linesToMap(task.fingerprintLines);
        const diff = diffFingerprints(current, previous);
        if (diff.changed) {
          // 先删（含类型互换的旧类型），再创建/更新，避免 mkdir/writeFile 撞类型。
          for (const rel of diff.remove) {
            await fs.rm(joinLocal(task.localDir, rel), { recursive: true, force: true });
          }
          for (const [rel, line] of diff.create) {
            const localFull = joinLocal(task.localDir, rel);
            if (line.startsWith('d:')) {
              await fs.mkdir(localFull, { recursive: true });
            } else {
              await this.downloadOne(
                session, path.posix.join(task.remotePath, rel), localFull
              );
            }
          }
          this.log(`同步基线更新: ${task.remotePath} -> ${task.localDir}（${lines.length} 项）`);
        }
      }
      task.isFile = isFile;
      task.fingerprintLines = lines;
      return true;
    } catch (error) {
      this.log(`同步基线失败: ${task.remotePath}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async runBaseline(task: RemoteSyncTask, attempt: number): Promise<void> {
    const key = taskKey(task.mountName, task.remotePath);
    const ok = await this.baseline(task);
    // 下载期间用户可能已经关闭同步（或用同一路径创建了新任务）；旧基线
    // 不得在这时复活 watcher 或把新任务错误标记为就绪。
    if (ok && this.tasks.get(key) === task) {
      this.readyTasks.add(key);
      await this.markTaskReady(task);
      this.startLocalWatcher(task);
      this.onTaskChanged();
      return;
    }
    if (ok) return;
    if (!this.tasks.has(key) || this.baselineTimers.has(key)) return;
    // 指数退避重试：连接中断/瞬时故障时不留下半初始化镜像。
    const delay = Math.min(baselineRetryBaseMs * 2 ** attempt, baselineRetryCapMs);
    const timer = setTimeout(() => {
      this.baselineTimers.delete(key);
      void this.runBaseline(task, attempt + 1);
    }, delay);
    timer.unref?.();
    this.baselineTimers.set(key, timer);
  }

  /** 下载单个远程文件到本地（流式落盘）；覆盖前检测下载窗口内的本地改动，避免覆盖用户编辑。 */
  private async downloadOne(
    session: SftpSession, remotePath: string, localFull: string
  ): Promise<void> {
    await this.withDownload(localFull, async () => {
      await fs.mkdir(path.dirname(localFull), { recursive: true });
      const before = await fs.stat(localFull).catch(() => undefined);
      // 流式下载到临时文件：下载期间目标文件不被触碰，完成后按 before/after
      // 比对决定是否替换——本地在下载期间被修改/删除则丢弃产物，保留用户改动。
      const temporaryPath = `${localFull}.safs-part`;
      try {
        await writeStreamToFile(await session.readFileStream(remotePath), temporaryPath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true });
        throw error;
      }
      const after = await fs.stat(localFull).catch(() => undefined);
      const unchanged = before === undefined && after === undefined
        || before !== undefined && after !== undefined && before.mtimeMs === after.mtimeMs;
      if (!unchanged) {
        await fs.rm(temporaryPath, { force: true });
        this.log(`跳过覆盖（下载期间本地被修改/删除）: ${localFull}`);
        return;
      }
      // 已验证下载期间本地未被改动：删除旧文件后原子替换（Windows rename 不覆盖）。
      await fs.rm(localFull, { force: true });
      await fs.rename(temporaryPath, localFull);
      const written = await fs.stat(localFull);
      this.downloadedMtimes.set(localFull, written.mtimeMs);
    });
  }

  /** 串行化同一本地路径的下载，并登记进行中状态（本地操作会等待它）。 */
  private async withDownload(localPath: string, fn: () => Promise<void>): Promise<void> {
    const existing = this.activeDownloads.get(localPath);
    if (existing) await existing;
    const promise = (async () => {
      this.localDownloading.add(localPath);
      try {
        await fn();
      } finally {
        this.localDownloading.delete(localPath);
      }
    })();
    this.activeDownloads.set(localPath, promise);
    try {
      return await promise;
    } finally {
      if (this.activeDownloads.get(localPath) === promise) {
        this.activeDownloads.delete(localPath);
      }
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
      await this.withDownload(localTarget, async () => {
        try {
          await fs.mkdir(localTarget, { recursive: true });
        } catch {
          // 本地同路径是文件（类型冲突）：先移除再建目录。
          await fs.rm(localTarget, { recursive: true, force: true });
          await fs.mkdir(localTarget, { recursive: true });
        }
      });
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
    if (task.isFile === undefined) return;
    const key = task.localDir;
    const existing = this.watchers.get(key);
    if (existing) {
      existing.taskKeys.add(taskKey(task.mountName, task.remotePath));
      return;
    }
    const dir = task.isFile ? path.dirname(task.localDir) : task.localDir;
    const pattern = task.isFile
      ? new vscode.RelativePattern(dir, path.basename(task.localDir))
      : new vscode.RelativePattern(dir, '**/*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const taskKeys = new Set([taskKey(task.mountName, task.remotePath)]);
    const dispatch = (kind: 'created' | 'changed' | 'deleted') => (uri: vscode.Uri) => {
      if (uri.fsPath.endsWith('.safs-part')) return;
      for (const candidate of this.tasks.values()) {
        if (!taskKeys.has(taskKey(candidate.mountName, candidate.remotePath))) continue;
        if (kind === 'created') this.onLocalCreated(candidate, uri);
        else if (kind === 'changed') this.onLocalChanged(candidate, uri);
        else this.onLocalDeleted(candidate, uri);
      }
    };
    watcher.onDidCreate(dispatch('created'));
    watcher.onDidChange(dispatch('changed'));
    watcher.onDidDelete(dispatch('deleted'));
    this.watchers.set(key, { watcher, taskKeys });
  }

  private remoteTargetFor(task: RemoteSyncTask, localPath: string): string {
    const rel = path.relative(task.localDir, localPath);
    return rel ? path.posix.join(task.remotePath, rel.split(path.sep).join('/')) : task.remotePath;
  }

  /**
   * 本地事件入队：(task, localPath) 串行执行，同路径在途事件合并（执行时按
   * 最新文件状态决定上传或删除远端，最新内容胜出）。下载在途时先等待其完成。
   */
  private enqueueLocalOp(task: RemoteSyncTask, localPath: string): void {
    const key = `${taskKey(task.mountName, task.remotePath)}\0${localPath}`;
    if (this.pendingLocalOps.has(key)) return;
    this.pendingLocalOps.add(key);
    const previous = this.localOpQueues.get(key) ?? Promise.resolve();
    const next = previous.then(() => this.performLocalOp(task, localPath)).finally(() => {
      this.pendingLocalOps.delete(key);
      if (this.localOpQueues.get(key) === next) this.localOpQueues.delete(key);
    });
    this.localOpQueues.set(key, next);
  }

  private async performLocalOp(task: RemoteSyncTask, localPath: string): Promise<void> {
    const active = this.activeDownloads.get(localPath);
    if (active) await active;
    const remoteFull = this.remoteTargetFor(task, localPath);
    const stat = await fs.stat(localPath).catch(() => undefined);
    if (!stat) {
      await this.performRemoteDelete(task, remoteFull);
      return;
    }
    // 下载回写触发的 watcher echo：本地 mtime 与最近一次下载写入一致，跳过。
    if (this.downloadedMtimes.get(localPath) === stat.mtimeMs) {
      this.downloadedMtimes.delete(localPath);
      return;
    }
    // 本地确有新改动：清理旧下载标记后上传最新内容。
    this.downloadedMtimes.delete(localPath);
    if (this.remoteUploading.has(remoteFull)) return;
    const session = await this.getSession(task.mountName);
    this.remoteUploading.add(remoteFull);
    try {
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

  private async performRemoteDelete(task: RemoteSyncTask, remoteFull: string): Promise<void> {
    if (this.remoteUploading.has(remoteFull)) return;
    this.status(`本地删除 → 远程: ${remoteFull}`);
    const session = await this.getSession(task.mountName);
    this.remoteUploading.add(remoteFull);
    try {
      await session.deleteFile(remoteFull).catch(() => session.deleteDirectory(remoteFull));
      this.log(`已删除远程: ${remoteFull}`);
    } catch (error) {
      this.log(`删除远程失败: ${remoteFull}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.remoteUploading.delete(remoteFull);
    }
  }

  private onLocalCreated(task: RemoteSyncTask, uri: vscode.Uri): void {
    this.status(`本地新建 → 远程: ${this.remoteTargetFor(task, uri.fsPath)}`);
    this.enqueueLocalOp(task, uri.fsPath);
  }

  private onLocalChanged(task: RemoteSyncTask, uri: vscode.Uri): void {
    this.status(`本地修改 → 远程: ${this.remoteTargetFor(task, uri.fsPath)}`);
    this.enqueueLocalOp(task, uri.fsPath);
  }

  private onLocalDeleted(task: RemoteSyncTask, uri: vscode.Uri): void {
    this.status(`本地删除 → 远程: ${this.remoteTargetFor(task, uri.fsPath)}`);
    this.enqueueLocalOp(task, uri.fsPath);
  }
}
