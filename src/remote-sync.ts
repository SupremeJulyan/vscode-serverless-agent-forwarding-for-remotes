import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { isRemotePathInsideRoot } from './sftp/uri';
import { SftpSession } from './sftp/session';
import { diffFingerprints, linesToMap, scanRemote } from './sync-diff';
import { writeStreamToFile } from './stream-file';
import { DownloadEchoGuard } from './sync-echo';

/**
 * 远程目录/文件 ↔ 本地目录的双向自动同步（事件驱动，不轮询）。
 *
 * 远程 → 本地：SAFS 文件系统变更通过 provider 回调即时同步；低频指纹扫描
 * 补获远程终端、Agent 或其他 SSH 客户端直接产生的变更。
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
  /** 首次基线前清空已有本地目标，确保远程权威镜像没有本地独有残留。 */
  resetLocalOnFirstSync?: boolean;
}

export interface RemoteSyncProgress {
  phase: 'scanning' | 'downloading';
  currentFile?: string;
  completedFiles: number;
  totalFiles: number;
  transferredBytes: number;
  totalBytes: number;
}

export interface RemoteSyncStartOptions {
  signal?: AbortSignal;
  onProgress?: (progress: RemoteSyncProgress) => void;
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
  /** 下载落盘指纹保留一小段时间，以吞掉同一次写入触发的 create/change 事件簇。 */
  private readonly downloadEchoes = new DownloadEchoGuard();
  /** (task,localPath) → 串行本地操作队列（尾沿合并）。 */
  private readonly localOpQueues = new Map<string, Promise<void>>();
  private readonly pendingLocalOps = new Set<string>();
  /** 基线失败后的退避重试定时器。 */
  private readonly baselineTimers = new Map<string, NodeJS.Timeout>();
  private readonly ownedTasks = new Set<string>();
  private readonly ownershipMonitors = new Map<string, NodeJS.Timeout>();
  private readonly pendingAcquireTimers = new Map<string, NodeJS.Timeout>();
  private readonly remoteScanTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly getSession: (mountName: string) => Promise<SftpSession>,
    private readonly resolveRemote: (
      uri: vscode.Uri
    ) => { mountName: string; remotePath: string } | undefined,
    private readonly log: (message: string) => void = () => undefined,
    private readonly onTaskChanged: (persist: boolean) => void = () => undefined,
    private readonly status: (message: string) => void = () => undefined,
    private readonly acquireTask: (task: RemoteSyncTask) => Promise<boolean> = async () => true,
    private readonly releaseTask: (task: RemoteSyncTask) => Promise<void> = async () => undefined,
    private readonly markTaskReady: (task: RemoteSyncTask) => Promise<void> = async () => undefined,
    private readonly isStopRequested: (task: RemoteSyncTask) => Promise<boolean> = async () => false,
    private readonly remoteScanIntervalMs = 5_000
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

  add(task: RemoteSyncTask, options: RemoteSyncStartOptions = {}): Promise<void> {
    const key = taskKey(task.mountName, task.remotePath);
    this.tasks.set(key, task);
    this.readyTasks.delete(key);
    return this.startTask(task, options);
  }

  private async startTask(
    task: RemoteSyncTask, options: RemoteSyncStartOptions = {}
  ): Promise<void> {
    const key = taskKey(task.mountName, task.remotePath);
    if (!await this.acquireTask(task)) {
      if (this.tasks.get(key) === task && !this.pendingAcquireTimers.has(key)) {
        const timer = setTimeout(() => {
          this.pendingAcquireTimers.delete(key);
          if (this.tasks.get(key) === task) void this.startTask(task);
        }, 1_000);
        timer.unref?.();
        this.pendingAcquireTimers.set(key, timer);
      }
      return;
    }
    const pendingAcquire = this.pendingAcquireTimers.get(key);
    if (pendingAcquire) clearTimeout(pendingAcquire);
    this.pendingAcquireTimers.delete(key);
    const remoteScan = this.remoteScanTimers.get(key);
    if (remoteScan) clearTimeout(remoteScan);
    this.remoteScanTimers.delete(key);
    if (this.tasks.get(key) !== task) {
      await this.releaseTask(task);
      return;
    }
    if (await this.isStopRequested(task)) {
      await this.releaseTask(task);
      this.remove(task.mountName, task.remotePath);
      return;
    }
    this.ownedTasks.add(key);
    // 只有取得任务所有权的窗口可以持久化任务/指纹；恢复任务的旁观窗口
    // 不得用自己的旧副本覆盖 owner 刚写入的状态。
    this.onTaskChanged(true);
    const monitor = setInterval(() => {
      void this.isStopRequested(task).then((stopped) => {
        if (stopped && this.tasks.get(key) === task) this.remove(task.mountName, task.remotePath);
      });
    }, 1_000);
    monitor.unref?.();
    this.ownershipMonitors.set(key, monitor);
    await this.runBaseline(task, 0, options);
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
    const pendingAcquire = this.pendingAcquireTimers.get(key);
    if (pendingAcquire) clearTimeout(pendingAcquire);
    this.pendingAcquireTimers.delete(key);
    const remoteScan = this.remoteScanTimers.get(key);
    if (remoteScan) clearTimeout(remoteScan);
    this.remoteScanTimers.delete(key);
    const wasOwned = this.ownedTasks.delete(key);
    if (wasOwned && task) void this.releaseTask(task);
    this.log(`已停止同步：${remotePath}`);
    // 非 owner 只更新自己的树视图；共享停止标记会让 owner 执行真正的持久化删除。
    this.onTaskChanged(wasOwned);
  }

  dispose(): void {
    for (const timer of this.baselineTimers.values()) clearTimeout(timer);
    this.baselineTimers.clear();
    for (const entry of this.watchers.values()) entry.watcher.dispose();
    this.watchers.clear();
    for (const monitor of this.ownershipMonitors.values()) clearInterval(monitor);
    this.ownershipMonitors.clear();
    for (const timer of this.pendingAcquireTimers.values()) clearTimeout(timer);
    this.pendingAcquireTimers.clear();
    for (const timer of this.remoteScanTimers.values()) clearTimeout(timer);
    this.remoteScanTimers.clear();
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
      if (!this.ownedTasks.has(taskKey(task.mountName, task.remotePath))) continue;
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
        // Windows 的 rename 不覆盖已存在目标（与下载替换同理）；先清除目标。
        // 大小写不同的改名（Foo→foo）在大小写不敏感文件系统上是同一文件，
        // 按 dev+ino 识别后跳过清除，避免误删唯一副本。
        const existing = await fs.stat(localTarget).catch(() => undefined);
        if (existing) {
          const source = await fs.stat(localFull).catch(() => undefined);
          const sameFile = source !== undefined
            && source.dev === existing.dev && source.ino === existing.ino;
          if (!sameFile) {
            await fs.rm(localTarget, { recursive: true, force: true }).catch(() => undefined);
          }
        }
        await fs.rename(localFull, localTarget).catch(() => undefined);
        this.log(`已重命名本地: ${localFull} -> ${localTarget}`);
      }
    } catch (error) {
      this.log(`同步到本地失败: ${remotePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 首次/恢复时的增量基线同步。成功返回 true；失败返回 false（触发退避重试）。 */
  private async baseline(
    task: RemoteSyncTask, showStatus = true, options: RemoteSyncStartOptions = {}
  ): Promise<boolean> {
    if (showStatus) this.status(`正在同步: ${task.remotePath} → ${task.localDir}`);
    try {
      const session = await this.getSession(task.mountName);
      options.onProgress?.({
        phase: 'scanning', completedFiles: 0, totalFiles: 0,
        transferredBytes: 0, totalBytes: 0
      });
      const lines = await scanRemote(session, task.remotePath, options.signal);
      const isFile = lines.length === 1 && lines[0].startsWith('f::');
      if (!task.fingerprintLines) {
        if (task.resetLocalOnFirstSync) {
          await fs.rm(task.localDir, { recursive: true, force: true });
        }
        const fileLines = lines.filter((line) => line.startsWith('f:'));
        const totalBytes = fileLines.reduce((sum, line) => {
          const relEnd = line.indexOf(':', 2);
          return sum + Number(line.slice(relEnd + 1).split(':', 1)[0] || 0);
        }, 0);
        const progressState = {
          completedFiles: 0, totalFiles: fileLines.length,
          transferredBytes: 0, totalBytes
        };
        await this.downloadTree(
          session, task.remotePath, task.localDir, isFile, options, progressState
        );
        task.resetLocalOnFirstSync = false;
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

  private async runBaseline(
    task: RemoteSyncTask, attempt: number, options: RemoteSyncStartOptions = {}
  ): Promise<void> {
    const key = taskKey(task.mountName, task.remotePath);
    const ok = await this.baseline(task, true, options);
    // 下载期间用户可能已经关闭同步（或用同一路径创建了新任务）；旧基线
    // 不得在这时复活 watcher 或把新任务错误标记为就绪。
    if (ok && this.tasks.get(key) === task) {
      this.readyTasks.add(key);
      await this.markTaskReady(task);
      this.startLocalWatcher(task);
      this.onTaskChanged(true);
      this.scheduleRemoteScan(task);
      return;
    }
    if (ok) return;
    if (options.signal?.aborted) {
      this.remove(task.mountName, task.remotePath);
      return;
    }
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

  private scheduleRemoteScan(task: RemoteSyncTask): void {
    const key = taskKey(task.mountName, task.remotePath);
    if (this.remoteScanTimers.has(key) || this.tasks.get(key) !== task
      || !this.ownedTasks.has(key)) return;
    const timer = setTimeout(() => {
      this.remoteScanTimers.delete(key);
      void this.runRemoteScan(task);
    }, this.remoteScanIntervalMs);
    timer.unref?.();
    this.remoteScanTimers.set(key, timer);
  }

  private async runRemoteScan(task: RemoteSyncTask): Promise<void> {
    const key = taskKey(task.mountName, task.remotePath);
    if (this.tasks.get(key) !== task || !this.ownedTasks.has(key)) return;
    const ok = await this.baseline(task, false);
    if (ok && this.tasks.get(key) === task) this.onTaskChanged(true);
    this.scheduleRemoteScan(task);
  }

  /** 下载单个远程文件到本地（流式落盘）；覆盖前检测下载窗口内的本地改动，避免覆盖用户编辑。 */
  private async downloadOne(
    session: SftpSession, remotePath: string, localFull: string,
    options: RemoteSyncStartOptions = {}, onDelta?: (delta: number) => void
  ): Promise<void> {
    await this.withDownload(localFull, async () => {
      await fs.mkdir(path.dirname(localFull), { recursive: true });
      const before = await fs.stat(localFull).catch(() => undefined);
      // 流式下载到临时文件：下载期间目标文件不被触碰，完成后按 before/after
      // 比对决定是否替换——本地在下载期间被修改/删除则丢弃产物，保留用户改动。
      // Extension Host 重载时旧基线可能仍在收尾；每次下载使用唯一临时文件，
      // 避免两个实例互相 rename/delete 同一个固定 .safs-part 路径。
      const temporaryPath = `${localFull}.${process.pid}-${randomBytes(6).toString('hex')}.safs-part`;
      try {
        await writeStreamToFile(
          await session.readFileStream(remotePath, options.signal), temporaryPath,
          { signal: options.signal, onDelta }
        );
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
      this.downloadEchoes.record(localFull, written);
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
    session: SftpSession, remotePath: string, localTarget: string, isFile?: boolean,
    options: RemoteSyncStartOptions = {},
    progressState?: {
      completedFiles: number; totalFiles: number; transferredBytes: number; totalBytes: number;
    }
  ): Promise<void> {
    if (isFile) {
      options.onProgress?.({
        phase: 'downloading', currentFile: remotePath,
        ...(progressState ?? {
          completedFiles: 0, totalFiles: 1, transferredBytes: 0, totalBytes: 0
        })
      });
      await this.downloadOne(session, remotePath, localTarget, {
        ...options,
        onProgress: undefined
      }, (delta) => {
        if (!progressState) return;
        progressState.transferredBytes += delta;
        options.onProgress?.({ phase: 'downloading', currentFile: remotePath, ...progressState });
      });
      if (progressState) {
        progressState.completedFiles++;
        options.onProgress?.({ phase: 'downloading', currentFile: remotePath, ...progressState });
      }
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
        const written = await fs.stat(localTarget);
        this.downloadEchoes.record(localTarget, written);
      });
      const entries = await session.readDirectory(remotePath, options.signal);
      for (const entry of entries) {
        await this.downloadTree(
          session,
          path.posix.join(remotePath, entry.name),
          path.join(localTarget, entry.name),
          entry.type !== 'directory', options, progressState
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
      this.downloadEchoes.forget(localPath);
      await this.performRemoteDelete(task, remoteFull);
      return;
    }
    // 单次原子下载可能连续触发 create/change；匹配指纹的整个事件簇都跳过。
    if (this.downloadEchoes.matches(localPath, stat)) return;
    if (this.remoteUploading.has(remoteFull)) return;
    this.status(`${stat.isDirectory() ? '本地新建' : '本地修改'} → 远程: ${remoteFull}`);
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
    this.enqueueLocalOp(task, uri.fsPath);
  }

  private onLocalChanged(task: RemoteSyncTask, uri: vscode.Uri): void {
    this.enqueueLocalOp(task, uri.fsPath);
  }

  private onLocalDeleted(task: RemoteSyncTask, uri: vscode.Uri): void {
    this.status(`本地删除 → 远程: ${this.remoteTargetFor(task, uri.fsPath)}`);
    this.enqueueLocalOp(task, uri.fsPath);
  }
}
