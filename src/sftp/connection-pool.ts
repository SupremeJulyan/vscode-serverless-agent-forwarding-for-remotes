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

  constructor(private readonly connector: SftpConnector) {}

  state(hostName: string): SftpConnectionState {
    return this.entries.get(hostName)?.state ?? 'disconnected';
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
      entry.session = undefined;
      entry.state = 'reconnecting';
    }
    if (entry?.connecting) return entry.connecting;
    entry = { state: entry ? 'reconnecting' : 'connecting', lastUsed: Date.now() };
    this.entries.set(hostName, entry);
    entry.connecting = this.connector(hostName, signal).then(
      (session) => {
        entry!.session = session;
        entry!.connecting = undefined;
        entry!.state = 'connected';
        entry!.error = undefined;
        entry!.lastUsed = Date.now();
        return session;
      },
      (error: unknown) => {
        entry!.connecting = undefined;
        entry!.state = 'error';
        entry!.error = error instanceof Error ? error : new Error(String(error));
        throw error;
      }
    );
    return entry.connecting;
  }

  async disconnect(hostName: string): Promise<void> {
    const entry = this.entries.get(hostName);
    this.entries.delete(hostName);
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
