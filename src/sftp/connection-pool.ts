import { SftpConnectionState, SftpSession } from './session';

interface PoolEntry {
  session?: SftpSession;
  connecting?: Promise<SftpSession>;
  state: SftpConnectionState;
  lastUsed: number;
  error?: Error;
}

export type SftpConnector = (hostName: string, signal?: AbortSignal) => Promise<SftpSession>;

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
      .filter(([, entry]) => entry.session && now - entry.lastUsed >= maxIdleMs)
      .map(([hostName]) => this.disconnect(hostName));
    await Promise.allSettled(idle);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((hostName) => this.disconnect(hostName)));
  }
}
