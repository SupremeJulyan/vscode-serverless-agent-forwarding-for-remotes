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
  /** 显式权限（八进制，如 0o644）：SCP 回退下写入时直接使用，跳过 exists/权限探测。 */
  mode?: number;
}

export interface SftpSession {
  readonly hostName: string;
  /** 传输通道：'sftp'（真 SFTP 子系统）或 'scp'（exec/SCP 回退）。 */
  readonly transport: 'sftp' | 'scp';

  isAlive(): boolean;
  realpath(remotePath: string, signal?: AbortSignal): Promise<string>;
  /** 解析（realpath）并 stat 一步完成：SCP 回退下合并为单条 exec（命令数减半），
   * SFTP 下等价于先 realpath 再 lstat。返回规范路径与 stat。 */
  statResolved(
    remotePath: string, signal?: AbortSignal
  ): Promise<{ path: string; stat: SftpFileStat }>;
  stat(remotePath: string, signal?: AbortSignal): Promise<SftpFileStat>;
  /** 解析（realpath）并列举一步完成：SCP 回退下合并为单条 exec，
   * SFTP 下等价于先 realpath 再 readdir。返回规范路径与条目。 */
  readDirectoryResolved(
    remotePath: string, signal?: AbortSignal
  ): Promise<{ path: string; entries: SftpDirectoryEntry[] }>;
  readDirectory(remotePath: string, signal?: AbortSignal): Promise<SftpDirectoryEntry[]>;
  readFile(remotePath: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** 按字节范围读取远程文件（offset 起、length 字节）。SCP 回退实现退化为整读后切片。 */
  readFileRange(
    remotePath: string, offset: number, length: number, signal?: AbortSignal
  ): Promise<Uint8Array>;
  /** 流式读取远程文件（分块返回），供大文件下载直接落盘，避免整文件驻留内存。 */
  readFileStream(remotePath: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream>;
  writeFile(
    remotePath: string,
    content: Uint8Array,
    options: SftpWriteOptions,
    signal?: AbortSignal
  ): Promise<void>;
  /** 原子替换目标文件（临时文件落盘）：保留权限（可选）并覆盖。SCP 回退下
   * chmod + mv -f 合并为一条 exec；SFTP 下等价 chmod + rename(overwrite)。
   * 调用方保证目标不存在或是普通文件（目录目标走 rename）。 */
  replaceFile(
    sourcePath: string, targetPath: string, mode?: number, signal?: AbortSignal
  ): Promise<void>;
  /** 流式写入远程文件（返回可写流），供大文件上传分块推送，避免整文件驻留内存。 */
  writeFileStream(
    remotePath: string,
    options: SftpWriteOptions,
    signal?: AbortSignal
  ): Promise<NodeJS.WritableStream>;
  chmod(remotePath: string, mode: number, signal?: AbortSignal): Promise<void>;
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
