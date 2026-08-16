import { SftpConnectionState, SftpFileStat, SftpSession, SftpWriteOptions } from './session';

interface PoolEntry {
  session?: SftpSession;
  connecting?: Promise<SftpSession>;
  state: SftpConnectionState;
  lastUsed: number;
  error?: Error;
}

export type SftpConnector = (hostName: string, signal?: AbortSignal) => Promise<SftpSession>;

/** 连接级错误：远端重置/半开连接/网络抖动等瞬时故障，值得失效会话并重连重试一次。 */
export function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED'
    || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH'
    || code === 'ECONNREFUSED') {
    return true;
  }
  return /socket hang up|connection (?:reset|closed|terminated)/i.test(error.message);
}

/**
 * 会话包装：单个操作遇到连接级错误时，使池中会话失效、重连，
 * 并在新会话上重试一次（瞬时重置对调用方透明，避免"read ECONNRESET"
 * 这类错误直接冒泡给用户）。
 */
class RetryingSftpSession implements SftpSession {
  readonly hostName: string;

  constructor(
    private readonly pool: SftpConnectionPool,
    hostName: string,
    private session: SftpSession
  ) {
    this.hostName = hostName;
  }

  get transport(): 'sftp' | 'scp' {
    // 重连后传输通道可能变化（如 SFTP 中途失效回退 SCP），实时读取当前会话。
    return this.session.transport;
  }

  private withRetry<T>(op: (session: SftpSession) => Promise<T>): Promise<T> {
    return op(this.session).catch(async (error: unknown) => {
      if (!isConnectionError(error)) throw error;
      // 连接级错误：失效旧会话并在新连接上重试一次（不递归，最多一次）。
      const fresh = await this.pool.reconnect(this.hostName);
      this.session = fresh;
      return op(fresh);
    });
  }

  isAlive(): boolean {
    return this.session.isAlive();
  }

  realpath(remotePath: string, signal?: AbortSignal): Promise<string> {
    return this.withRetry((session) => session.realpath(remotePath, signal));
  }

  statResolved(
    remotePath: string, signal?: AbortSignal
  ): Promise<{ path: string; stat: SftpFileStat }> {
    return this.withRetry((session) => session.statResolved(remotePath, signal));
  }

  stat(remotePath: string, signal?: AbortSignal): Promise<SftpFileStat> {
    return this.withRetry((session) => session.stat(remotePath, signal));
  }

  readDirectoryResolved(
    remotePath: string, signal?: AbortSignal
  ): ReturnType<SftpSession['readDirectoryResolved']> {
    return this.withRetry((session) => session.readDirectoryResolved(remotePath, signal));
  }

  readDirectory(remotePath: string, signal?: AbortSignal): ReturnType<SftpSession['readDirectory']> {
    return this.withRetry((session) => session.readDirectory(remotePath, signal));
  }

  readFile(remotePath: string, signal?: AbortSignal): Promise<Uint8Array> {
    return this.withRetry((session) => session.readFile(remotePath, signal));
  }

  writeFile(
    remotePath: string, content: Uint8Array, options: SftpWriteOptions, signal?: AbortSignal
  ): Promise<void> {
    return this.withRetry((session) => session.writeFile(remotePath, content, options, signal));
  }

  replaceFile(
    sourcePath: string, targetPath: string, mode?: number, signal?: AbortSignal
  ): Promise<void> {
    return this.withRetry(
      (session) => session.replaceFile(sourcePath, targetPath, mode, signal)
    );
  }

  writeFileStream(
    remotePath: string, options: SftpWriteOptions, signal?: AbortSignal
  ): Promise<NodeJS.WritableStream> {
    return this.withRetry((session) => session.writeFileStream(remotePath, options, signal));
  }

  chmod(remotePath: string, mode: number, signal?: AbortSignal): Promise<void> {
    return this.withRetry((session) => session.chmod(remotePath, mode, signal));
  }

  createDirectory(remotePath: string, signal?: AbortSignal): Promise<void> {
    return this.withRetry((session) => session.createDirectory(remotePath, signal));
  }

  deleteFile(remotePath: string, signal?: AbortSignal): Promise<void> {
    return this.withRetry((session) => session.deleteFile(remotePath, signal));
  }

  deleteDirectory(remotePath: string, signal?: AbortSignal): Promise<void> {
    return this.withRetry((session) => session.deleteDirectory(remotePath, signal));
  }

  readFileRange(
    remotePath: string, offset: number, length: number, signal?: AbortSignal
  ): Promise<Uint8Array> {
    return this.withRetry((session) => session.readFileRange(remotePath, offset, length, signal));
  }

  readFileStream(remotePath: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream> {
    return this.withRetry((session) => session.readFileStream(remotePath, signal));
  }

  rename(
    sourcePath: string, targetPath: string, overwrite: boolean, signal?: AbortSignal
  ): Promise<void> {
    return this.withRetry(
      (session) => session.rename(sourcePath, targetPath, overwrite, signal)
    );
  }

  close(): Promise<void> {
    return this.session.close();
  }
}

export class SftpConnectionPool {
  private readonly entries = new Map<string, PoolEntry>();

  constructor(
    private readonly connector: SftpConnector,
    private readonly stateChanged: (hostName: string) => void = () => undefined
  ) {}

  state(hostName: string): SftpConnectionState {
    const entry = this.entries.get(hostName);
    if (entry?.state === 'connected' && !entry.session?.isAlive()) return 'disconnected';
    return entry?.state ?? 'disconnected';
  }

  error(hostName: string): Error | undefined {
    return this.entries.get(hostName)?.error;
  }

  async get(hostName: string, signal?: AbortSignal): Promise<SftpSession> {
    return new RetryingSftpSession(this, hostName, await this.raw(hostName, signal));
  }

  /** 使当前会话失效并返回新连接（供会话包装器在连接级错误后重试一次）。 */
  async reconnect(hostName: string): Promise<SftpSession> {
    await this.invalidate(hostName);
    return this.raw(hostName);
  }

  /** 使当前会话失效（关闭并释放中继租约），状态置为 reconnecting。幂等。 */
  async invalidate(hostName: string): Promise<void> {
    const entry = this.entries.get(hostName);
    if (!entry?.session) return;
    const stale = entry.session;
    entry.session = undefined;
    entry.state = 'reconnecting';
    this.stateChanged(hostName);
    void stale.close().catch(() => undefined);
  }

  private async raw(hostName: string, signal?: AbortSignal): Promise<SftpSession> {
    let entry = this.entries.get(hostName);
    if (entry?.session?.isAlive()) {
      entry.lastUsed = Date.now();
      return entry.session;
    }
    if (entry?.session) {
      const stale = entry.session;
      entry.session = undefined;
      entry.state = 'reconnecting';
      // 释放旧会话（含 WSL VPN 中继租约与底层 Client），避免资源泄漏。
      void stale.close().catch(() => undefined);
    }
    if (entry?.connecting) return entry.connecting;
    entry = { state: entry ? 'reconnecting' : 'connecting', lastUsed: Date.now() };
    this.entries.set(hostName, entry);
    this.stateChanged(hostName);
    entry.connecting = this.connector(hostName, signal).then(
      (session) => {
        entry!.session = session;
        entry!.connecting = undefined;
        entry!.state = 'connected';
        entry!.error = undefined;
        entry!.lastUsed = Date.now();
        this.stateChanged(hostName);
        return session;
      },
      (error: unknown) => {
        entry!.connecting = undefined;
        entry!.state = 'error';
        entry!.error = error instanceof Error ? error : new Error(String(error));
        this.stateChanged(hostName);
        throw error;
      }
    );
    return entry.connecting;
  }

  async disconnect(hostName: string): Promise<void> {
    const entry = this.entries.get(hostName);
    this.entries.delete(hostName);
    this.stateChanged(hostName);
    const session = entry?.session ?? await entry?.connecting?.catch(() => undefined);
    await session?.close();
  }

  async closeIdle(maxIdleMs: number, now = Date.now()): Promise<void> {
    const idle = [...this.entries.entries()]
      .filter(([, entry]) => entry.session && now - entry.lastUsed >= maxIdleMs);
    await Promise.allSettled(idle.map(async ([hostName, entry]) => {
      // 关闭前复核：期间被再次使用（lastUsed 更新）则放弃回收，
      // 消除"判断空闲 → 异步关闭"之间新操作拿到该会话的竞态。
      if (Date.now() - entry.lastUsed < maxIdleMs) return;
      await this.disconnect(hostName);
    }));
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((hostName) => this.disconnect(hostName)));
  }
}
