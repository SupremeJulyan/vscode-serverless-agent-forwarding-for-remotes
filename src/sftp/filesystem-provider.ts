import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { SftpConnectionPool } from './connection-pool';
import { SftpFileStat, SftpSession } from './session';
import { recordScpOperationTime } from '../scp-timing';
import {
  isRemotePathInsideRoot, parseRemoteUri, remoteFileSystemScheme, remoteUri
} from './uri';

export interface RemoteFolder {
  mountName: string;
  hostName: string;
  remoteRoot: string;
  /** POSIX URI path backed by a real directory in extension global storage. */
  workspaceRoot: string;
}

export function remotePathForUri(folder: RemoteFolder, uriPath: string): string {
  if (isRemotePathInsideRoot(folder.workspaceRoot, uriPath)) {
    return path.posix.join(
      folder.remoteRoot, path.posix.relative(folder.workspaceRoot, uriPath)
    );
  }
  return uriPath;
}

export function workspacePathForRemote(folder: RemoteFolder, remotePath: string): string {
  if (!isRemotePathInsideRoot(folder.remoteRoot, remotePath)) return remotePath;
  return path.posix.join(
    folder.workspaceRoot, path.posix.relative(folder.remoteRoot, remotePath)
  );
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface WatchedResource {
  uri: vscode.Uri;
  snapshot?: string;
  references: number;
}

function fileType(type: SftpFileStat['type']): vscode.FileType {
  switch (type) {
    case 'file': return vscode.FileType.File;
    case 'directory': return vscode.FileType.Directory;
    case 'symbolic-link': return vscode.FileType.SymbolicLink;
    default: return vscode.FileType.Unknown;
  }
}

function fileStat(stat: SftpFileStat): vscode.FileStat {
  return {
    type: fileType(stat.type),
    ctime: stat.ctime,
    mtime: stat.mtime,
    size: stat.size,
    permissions: stat.permissions === undefined
      ? undefined
      : (stat.permissions & 0o222 ? undefined : vscode.FilePermission.Readonly)
  };
}

function errorCode(error: unknown): number | string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: number | string };
  return value.code;
}

function providerError(error: unknown, uri: vscode.Uri): never {
  if (error instanceof vscode.FileSystemError) throw error;
  const code = errorCode(error);
  if (code === 2 || code === 'ENOENT') throw vscode.FileSystemError.FileNotFound(uri);
  if (code === 3 || code === 'EACCES' || code === 'EPERM') {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  if (code === 4 || code === 'EEXIST') throw vscode.FileSystemError.FileExists(uri);
  const message = error instanceof Error ? error.message : String(error);
  throw vscode.FileSystemError.Unavailable(`${uri.toString()}: ${message}`);
}

export class RemoteFolderRegistry {
  private readonly folders = new Map<string, RemoteFolder>();

  set(folder: RemoteFolder): void {
    this.folders.set(folder.mountName, folder);
  }

  get(mountName: string): RemoteFolder | undefined {
    return this.folders.get(mountName);
  }

  delete(mountName: string): void {
    this.folders.delete(mountName);
  }

  values(): RemoteFolder[] {
    return [...this.folders.values()];
  }

  uri(folder: RemoteFolder): vscode.Uri {
    return vscode.Uri.parse(remoteUri(folder.mountName, folder.workspaceRoot));
  }
}

export class SftpFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly statCache = new Map<string, CacheEntry<vscode.FileStat>>();
  private readonly directoryCache = new Map<string, CacheEntry<[string, vscode.FileType][]>>();
  private readonly watched = new Map<string, WatchedResource>();
  private readonly watchTimer: NodeJS.Timeout;
  readonly onDidChangeFile = this.changes.event;
  /** 单个文件系统操作超过该时长时上报 onSlowOperation（诊断慢操作的调用方）。 */
  private static readonly slowOpThresholdMs = 1500;

  constructor(
    private readonly pool: SftpConnectionPool,
    private readonly registry: RemoteFolderRegistry,
    private readonly cacheTtlMs: number,
    watchIntervalMs: number,
    private readonly onMutation?: (
      uri: vscode.Uri, kind: 'write' | 'delete' | 'rename' | 'mkdir', targetUri?: vscode.Uri
    ) => void,
    private readonly onSlowOperation?: (label: string, ms: number) => void,
    private readonly onScpTiming?: (label: string, ms: number) => void
  ) {
    this.watchTimer = setInterval(() => void this.pollWatches(), watchIntervalMs);
    this.watchTimer.unref();
  }

  private traceSlow(label: string, start: number): void {
    const ms = Date.now() - start;
    if (ms > SftpFileSystemProvider.slowOpThresholdMs) this.onSlowOperation?.(label, ms);
  }

  private async resolveBase(uri: vscode.Uri): Promise<{
    folder: RemoteFolder;
    translatedPath: string;
    session: SftpSession;
  }> {
    if (uri.scheme !== remoteFileSystemScheme) {
      throw vscode.FileSystemError.Unavailable(`Unsupported URI scheme: ${uri.scheme}`);
    }
    const location = parseRemoteUri(uri.toString());
    const folder = this.registry.get(location.mountName);
    if (!folder) throw vscode.FileSystemError.Unavailable(`Unknown remote folder: ${location.mountName}`);
    if (!isRemotePathInsideRoot(folder.workspaceRoot, location.remotePath)) {
      throw vscode.FileSystemError.NoPermissions(
        'The URI is outside the storage-backed workspace namespace'
      );
    }
    const translatedPath = remotePathForUri(folder, location.remotePath);
    if (!isRemotePathInsideRoot(folder.remoteRoot, translatedPath)) {
      throw vscode.FileSystemError.NoPermissions('The path is outside the remote workspace root');
    }
    const session = await this.pool.get(folder.hostName);
    return { folder, translatedPath, session };
  }

  private async resolve(uri: vscode.Uri, allowMissing = false): Promise<{
    folder: RemoteFolder;
    remotePath: string;
    session: SftpSession;
  }> {
    const { folder, translatedPath, session } = await this.resolveBase(uri);
    let securedPath: string;
    try {
      securedPath = await session.realpath(translatedPath);
    } catch (error) {
      if (!allowMissing || (errorCode(error) !== 2 && errorCode(error) !== 'ENOENT')) throw error;
      const parent = await session.realpath(path.posix.dirname(translatedPath));
      securedPath = path.posix.join(parent, path.posix.basename(translatedPath));
    }
    if (!isRemotePathInsideRoot(folder.remoteRoot, securedPath)) {
      throw vscode.FileSystemError.NoPermissions(
        'A symbolic link resolves outside the remote workspace root'
      );
    }
    return {
      folder,
      remotePath: securedPath,
      session
    };
  }

  private valid<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private store<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): T {
    cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs });
    return value;
  }

  private invalidate(uri: vscode.Uri): void {
    const key = uri.toString();
    this.statCache.delete(key);
    this.directoryCache.delete(key);
    const parent = uri.with({ path: path.posix.dirname(uri.path) }).toString();
    this.directoryCache.delete(parent);
    this.statCache.delete(parent);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const start = Date.now();
    const key = uri.toString();
    const cached = this.valid(this.statCache, key);
    if (cached) return cached;
    try {
      const { session, remotePath } = await this.resolve(uri);
      const value = this.store(this.statCache, key, fileStat(await session.stat(remotePath)));
      this.traceSlow('stat', start);
      return value;
    } catch (error) {
      this.traceSlow('stat', start);
      providerError(error, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const start = Date.now();
    const key = uri.toString();
    const cached = this.valid(this.directoryCache, key);
    if (cached) return cached;
    try {
      // 合并 realpath + 列举（SCP 回退下一条 exec，SFTP 下等价原两步），
      // 由返回的规范路径做符号链接越界校验。
      const { folder, translatedPath, session } = await this.resolveBase(uri);
      const { path: securedPath, entries } = await recordScpOperationTime(
        '列出远程目录',
        async () => session.readDirectoryResolved(translatedPath),
        {
          transport: session.transport,
          log: (message) => this.onScpTiming?.('列出远程目录', Number(message.match(/(\d+)ms$/)?.[1] ?? 0)),
          onTiming: this.onScpTiming
        }
      );
      if (!isRemotePathInsideRoot(folder.remoteRoot, securedPath)) {
        throw vscode.FileSystemError.NoPermissions(
          'A symbolic link resolves outside the remote workspace root'
        );
      }
      const result: [string, vscode.FileType][] = [];
      for (const entry of entries) {
        if (entry.name === '.' || entry.name === '..') continue;
        result.push([entry.name, fileType(entry.type)]);
        // 预填子项 stat 缓存：列举已带完整元数据（size/mtime/mode），随后编辑器/
        // 资源管理器对子项的 stat 直接命中，不再产生网络请求（打开文件少一次往返）。
        // 符号链接除外：其真实类型需按需 stat（与 realpath 缓存同策略，防不一致）。
        if (entry.type !== 'symbolic-link') {
          this.store(
            this.statCache,
            vscode.Uri.joinPath(uri, entry.name).toString(),
            fileStat(entry)
          );
        }
      }
      this.traceSlow('readDirectory', start);
      return this.store(this.directoryCache, key, result);
    } catch (error) {
      this.traceSlow('readDirectory', start);
      providerError(error, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const start = Date.now();
    try {
      const { session, remotePath } = await this.resolve(uri);
      const value = await recordScpOperationTime(
        '打开远程文件',
        async () => session.readFile(remotePath),
        {
          transport: session.transport,
          log: (message) => this.onScpTiming?.('打开远程文件', Number(message.match(/(\d+)ms$/)?.[1] ?? 0)),
          onTiming: this.onScpTiming
        }
      );
      this.traceSlow('readFile', start);
      return value;
    } catch (error) {
      this.traceSlow('readFile', start);
      providerError(error, uri);
    }
  }

  async writeFile(
    uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    try {
      const { session, remotePath } = await this.resolve(uri, true);
      const temporaryPath = `${remotePath}.safs-${randomBytes(6).toString('hex')}`;
      try {
        // 临时文件写入：随机名 + 显式 mode（SCP 回退下跳过 exists/权限探测，
        // 少一条 exec）；覆盖语义由下面针对最终路径的 stat 保证。
        await recordScpOperationTime(
          '修改远程文件',
          async () => session.writeFile(temporaryPath, content, {
            create: true, overwrite: true, mode: 0o644
          }),
          {
            transport: session.transport,
            log: (message) => this.onScpTiming?.('修改远程文件', Number(message.match(/(\d+)ms$/)?.[1] ?? 0)),
            onTiming: this.onScpTiming
          }
        );
        let existing: import('./session').SftpFileStat | undefined;
        if (!options.overwrite) {
          try {
            await session.stat(remotePath);
            throw vscode.FileSystemError.FileExists(uri);
          } catch (error) {
            if (error instanceof vscode.FileSystemError) throw error;
            if (errorCode(error) !== 2 && errorCode(error) !== 'ENOENT') throw error;
          }
        } else {
          try {
            existing = await session.stat(remotePath);
          } catch (error) {
            if (!options.create || (errorCode(error) !== 2 && errorCode(error) !== 'ENOENT')) {
              throw error;
            }
          }
        }
        if (existing === undefined || existing.type === 'file') {
          // 常规：新文件或覆盖普通文件——chmod（保留权限）+ mv 合并为一条命令
          // （SCP 回退下从 3-4 条 exec 降为 1 条）。
          await session.replaceFile(temporaryPath, remotePath, existing?.permissions);
        } else {
          // 目录目标（罕见）：维持原有行为（chmod + rename，rename 会先删目标目录）。
          if (existing.permissions !== undefined) {
            await session.chmod(temporaryPath, existing.permissions).catch(() => undefined);
          }
          await session.rename(temporaryPath, remotePath, options.overwrite);
        }
      } catch (error) {
        await session.deleteFile(temporaryPath).catch(() => undefined);
        throw error;
      }
      this.invalidate(uri);
      this.changes.fire([
        { type: vscode.FileChangeType.Changed, uri },
        { type: vscode.FileChangeType.Changed, uri: vscode.Uri.joinPath(uri, '..') }
      ]);
      this.onMutation?.(uri, 'write');
    } catch (error) {
      providerError(error, uri);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    try {
      const { session, remotePath } = await this.resolve(uri, true);
      await session.createDirectory(remotePath);
      this.invalidate(uri);
      this.changes.fire([{ type: vscode.FileChangeType.Created, uri }]);
      this.onMutation?.(uri, 'mkdir');
    } catch (error) {
      providerError(error, uri);
    }
  }

  private async deleteRecursive(session: SftpSession, remotePath: string): Promise<void> {
    const stat = await session.stat(remotePath);
    if (stat.type !== 'directory') {
      await session.deleteFile(remotePath);
      return;
    }
    const children = await session.readDirectory(remotePath);
    for (const child of children) {
      if (child.name === '.' || child.name === '..') continue;
      await this.deleteRecursive(session, path.posix.join(remotePath, child.name));
    }
    await session.deleteDirectory(remotePath);
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    try {
      const { folder, session, remotePath } = await this.resolve(uri);
      if (remotePath === folder.remoteRoot) {
        throw vscode.FileSystemError.NoPermissions('The remote workspace root cannot be deleted');
      }
      const stat = await session.stat(remotePath);
      if (stat.type === 'directory' && options.recursive) {
        await this.deleteRecursive(session, remotePath);
      } else if (stat.type === 'directory') {
        await session.deleteDirectory(remotePath);
      } else {
        await session.deleteFile(remotePath);
      }
      this.invalidate(uri);
      this.changes.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
      this.onMutation?.(uri, 'delete');
    } catch (error) {
      providerError(error, uri);
    }
  }

  async rename(
    oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }
  ): Promise<void> {
    try {
      const source = await this.resolve(oldUri);
      const target = await this.resolve(newUri, true);
      if (source.folder.hostName !== target.folder.hostName) {
        throw vscode.FileSystemError.Unavailable('Cannot rename across SFTP connections');
      }
      if (options.overwrite) {
        await target.session.stat(target.remotePath).then(async (stat) => {
          if (stat.type === 'directory') await target.session.deleteDirectory(target.remotePath);
          else await target.session.deleteFile(target.remotePath);
        }).catch((error) => {
          if (errorCode(error) !== 2 && errorCode(error) !== 'ENOENT') throw error;
        });
      }
      await source.session.rename(source.remotePath, target.remotePath, options.overwrite);
      this.invalidate(oldUri);
      this.invalidate(newUri);
      this.changes.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri }
      ]);
      this.onMutation?.(oldUri, 'rename', newUri);
    } catch (error) {
      providerError(error, oldUri);
    }
  }

  watch(uri: vscode.Uri): vscode.Disposable {
    const key = uri.toString();
    const existing = this.watched.get(key);
    if (existing) existing.references += 1;
    else this.watched.set(key, { uri, references: 1 });
    return new vscode.Disposable(() => {
      const watched = this.watched.get(key);
      if (!watched) return;
      watched.references -= 1;
      if (watched.references <= 0) this.watched.delete(key);
    });
  }

  private async pollWatches(): Promise<void> {
    // 并行轮询所有 watch 项：串行版在网关（SCP 回退，每条 exec 秒级）下会让
    // 单次慢操作拖住全部 watch 项，且长时间占满会话并发额度，用户操作排队。
    // 并发上限由会话自身的 channel 信号量（ScpSession 5）天然约束。
    const targets = [...this.watched.values()];
    await Promise.allSettled(targets.map(async (watched) => {
      try {
        const stat = await this.stat(watched.uri);
        const snapshot = `${stat.type}:${stat.mtime}:${stat.size}`;
        if (watched.snapshot !== undefined && watched.snapshot !== snapshot) {
          this.invalidate(watched.uri);
          this.changes.fire([{ type: vscode.FileChangeType.Changed, uri: watched.uri }]);
        }
        watched.snapshot = snapshot;
      } catch {
        if (watched.snapshot !== undefined) {
          watched.snapshot = undefined;
          this.invalidate(watched.uri);
          this.changes.fire([{ type: vscode.FileChangeType.Deleted, uri: watched.uri }]);
        }
      }
    }));
  }

  dispose(): void {
    clearInterval(this.watchTimer);
    this.changes.dispose();
    this.statCache.clear();
    this.directoryCache.clear();
    this.watched.clear();
  }
}
