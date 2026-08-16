export type ScpTransport = 'sftp' | 'scp';

export interface ScpTimingOptions {
  transport: ScpTransport;
  log?: (message: string) => void;
  onTiming?: (label: string, ms: number) => void;
}

export async function recordScpOperationTime<T>(
  label: string,
  action: () => Promise<T>,
  { transport, log, onTiming }: ScpTimingOptions
): Promise<T> {
  if (transport !== 'scp') {
    return await action();
  }

  const startedAt = Date.now();
  try {
    return await action();
  } finally {
    const ms = Date.now() - startedAt;
    const message = `[SCP 耗时] ${label}: ${ms}ms`;
    log?.(message);
    onTiming?.(label, ms);
  }
}
