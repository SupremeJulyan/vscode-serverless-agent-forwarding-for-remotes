/**
 * Protocol-neutral SFTP primitives used by the future VS Code file-system
 * provider. Keeping ssh2 types behind this interface makes the provider
 * testable without a live SSH server.
 */
export type SftpFileType = 'file' | 'directory' | 'symbolic-link' | 'unknown';

export interface SftpFileStat {
  type: SftpFileType;
  size: number;
  mtime: number;
  ctime: number;
  permissions?: number;
}

export interface SftpDirectoryEntry extends SftpFileStat {
  name: string;
}

export interface SftpWriteOptions {
  create: boolean;
  overwrite: boolean;
}

export interface SftpSession {
  readonly hostName: string;

  isAlive(): boolean;
  realpath(remotePath: string, signal?: AbortSignal): Promise<string>;
  stat(remotePath: string, signal?: AbortSignal): Promise<SftpFileStat>;
  readDirectory(remotePath: string, signal?: AbortSignal): Promise<SftpDirectoryEntry[]>;
  readFile(remotePath: string, signal?: AbortSignal): Promise<Uint8Array>;
  writeFile(
    remotePath: string,
    content: Uint8Array,
    options: SftpWriteOptions,
    signal?: AbortSignal
  ): Promise<void>;
  createDirectory(remotePath: string, signal?: AbortSignal): Promise<void>;
  deleteFile(remotePath: string, signal?: AbortSignal): Promise<void>;
  deleteDirectory(remotePath: string, signal?: AbortSignal): Promise<void>;
  rename(
    sourcePath: string,
    targetPath: string,
    overwrite: boolean,
    signal?: AbortSignal
  ): Promise<void>;
  close(): Promise<void>;
}

export type SftpConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export interface SftpSessionFactory {
  connect(hostName: string, signal?: AbortSignal): Promise<SftpSession>;
}
