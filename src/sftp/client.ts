import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Writable } from 'node:stream';
import { Client, ConnectConfig, FileEntryWithStats, HostVerifier, SFTPWrapper, Stats } from 'ssh2';
import { expandHome, HostConfig } from '../config';
import { keyboardInteractivePasswordReplies } from '../authentication';
import { defaultSshClientIdent, serverHostKeyAlgorithms } from '../ssh-algorithms';
import { vpnRelayPoolPath } from '../wsl-bridge';
import { ScpSession } from './scp-session';
import {
  SftpDirectoryEntry, SftpFileStat, SftpFileType, SftpSession, SftpWriteOptions
} from './session';

const execFileAsync = promisify(execFile);

interface RelayLease {
  host: string;
  port: number;
  release(): Promise<void>;
}

function fileType(attributes: Stats): SftpFileType {
  if (attributes.isFile()) return 'file';
  if (attributes.isDirectory()) return 'directory';
  if (attributes.isSymbolicLink()) return 'symbolic-link';
  return 'unknown';
}

function fileStat(attributes: Stats): SftpFileStat {
  return {
    type: fileType(attributes),
    size: attributes.size,
    mtime: attributes.mtime * 1000,
    // ssh2 Stats 无 ctime：用 mtime 近似。此前误用 atime（会随读操作变化，
    // 导致 FileStat.ctime 语义错误）。
    ctime: attributes.mtime * 1000,
    permissions: attributes.mode & 0o7777
  };
}

function abortError(): Error {
  const error = new Error('SFTP operation was cancelled');
  error.name = 'AbortError';
  return error;
}

/** 流式写单个数据块的超时：远端停止确认（网关/抖动）时避免无限挂起。 */
const sftpWriteChunkTimeoutMs = 60_000;

function callback<T>(
  invoke: (done: (error: Error | undefined | null, value: T) => void) => void,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      // ssh2 的 SFTP 请求本身没有超时：网关偶发“收到请求但永不回复”
      // （半开/坏包）会让该操作永久挂起。控制类操作加超时保护。
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', aborted);
        reject(new Error(`SFTP 操作超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
    }
    const aborted = () => {
      if (timer) clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', aborted, { once: true });
    invoke((error, value) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve(value);
    });
  });
}

/** SFTP 控制类操作（元数据/目录/重命名等）的超时：防止请求石沉大海永久挂起。
 * 文件内容传输（readFile/writeFile/流式读写）不走该超时，避免大文件被误杀。 */
const sftpControlTimeoutMs = 60_000;

export class Ssh2SftpSession implements SftpSession {
  readonly transport = 'sftp' as const;
  private alive = true;

  constructor(
    readonly hostName: string,
    private readonly client: Client,
    private readonly sftp: SFTPWrapper,
    private readonly releaseRelay?: () => Promise<void>
  ) {
    const disconnected = () => {
      this.alive = false;
    };
    this.client.on('close', disconnected);
    this.client.on('end', disconnected);
    this.client.on('error', disconnected);
  }

  isAlive(): boolean {
    return this.alive;
  }

  realpath(remotePath: string, signal?: AbortSignal): Promise<string> {
    return callback((done) => this.sftp.realpath(remotePath, done), signal, sftpControlTimeoutMs);
  }

  async statResolved(
    remotePath: string, signal?: AbortSignal
  ): Promise<{ path: string; stat: SftpFileStat }> {
    const path = await this.realpath(remotePath, signal);
    return { path, stat: await this.stat(path, signal) };
  }

  async stat(remotePath: string, signal?: AbortSignal): Promise<SftpFileStat> {
    return fileStat(await callback(
      (done) => this.sftp.lstat(remotePath, done), signal, sftpControlTimeoutMs
    ));
  }

  async readDirectory(
    remotePath: string, signal?: AbortSignal
  ): Promise<SftpDirectoryEntry[]> {
    const entries = await callback<FileEntryWithStats[]>(
      (done) => this.sftp.readdir(remotePath, done),
      signal,
      sftpControlTimeoutMs
    );
    return entries.map((entry) => ({
      name: entry.filename,
      ...fileStat(entry.attrs)
    }));
  }

  async readDirectoryResolved(
    remotePath: string, signal?: AbortSignal
  ): Promise<{ path: string; entries: SftpDirectoryEntry[] }> {
    const path = await this.realpath(remotePath, signal);
    return { path, entries: await this.readDirectory(path, signal) };
  }

  readFile(remotePath: string, signal?: AbortSignal): Promise<Uint8Array> {
    return callback<Buffer>((done) => this.sftp.readFile(remotePath, done), signal);
  }

  readFileRange(
    remotePath: string, offset: number, length: number, signal?: AbortSignal
  ): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const chunks: Buffer[] = [];
      // createReadStream 的 start/end 走底层 read 范围，避免整文件下载。
      const stream = this.sftp.createReadStream(remotePath, {
        start: offset, end: offset + length - 1
      });
      const aborted = () => {
        stream.destroy();
        reject(abortError());
      };
      signal?.addEventListener('abort', aborted, { once: true });
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.once('error', (error: Error) => {
        signal?.removeEventListener('abort', aborted);
        reject(error);
      });
      stream.once('end', () => {
        signal?.removeEventListener('abort', aborted);
        resolve(Buffer.concat(chunks));
      });
    });
  }

  readFileStream(remotePath: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream> {
    return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const stream = this.sftp.createReadStream(remotePath);
      const aborted = () => {
        stream.destroy();
        reject(abortError());
      };
      signal?.addEventListener('abort', aborted, { once: true });
      stream.once('error', (error: Error) => {
        signal?.removeEventListener('abort', aborted);
        reject(error);
      });
      stream.once('open', () => {
        signal?.removeEventListener('abort', aborted);
        resolve(stream);
      });
    });
  }

  async writeFile(
    remotePath: string,
    content: Uint8Array,
    options: SftpWriteOptions,
    signal?: AbortSignal
  ): Promise<void> {
    const flag = options.create
      ? (options.overwrite ? 'w' : 'wx')
      : (options.overwrite ? 'r+' : 'r+');
    await callback<void>(
      (done) => this.sftp.writeFile(remotePath, Buffer.from(content), { flag }, done),
      signal
    );
  }

  async replaceFile(
    sourcePath: string, targetPath: string, mode?: number, signal?: AbortSignal
  ): Promise<void> {
    if (mode !== undefined) {
      await this.chmod(sourcePath, mode, signal);
    }
    await this.rename(sourcePath, targetPath, true, signal);
  }

  writeFileStream(
    remotePath: string,
    options: SftpWriteOptions,
    signal?: AbortSignal
  ): Promise<NodeJS.WritableStream> {
    const flag = options.create
      ? (options.overwrite ? 'w' : 'wx')
      : (options.overwrite ? 'r+' : 'r+');
    const sftp = this.sftp;
    return new Promise<NodeJS.WritableStream>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      // 句柄式分块写：ssh2 的 createWriteStream 在大文件/网关下存在写位置与背压
      // 缺陷（首个块后不再排空，上传卡在开头几百字节）。这里用
      // open → 逐块 write(显式偏移) → close 流式写：写回调驱动背压，
      // 与整写 writeFile 走同一底层语义；每个块带超时防无限挂起。
      sftp.open(remotePath, flag, (openError, handle) => {
        if (openError) {
          reject(openError);
          return;
        }
        let position = 0;
        let handleOpen = true;
        let pendingTimer: NodeJS.Timeout | undefined;
        const writable = new Writable({
          highWaterMark: 64 * 1024,
          write(chunk: Buffer, _encoding, callback) {
            pendingTimer = setTimeout(() => {
              pendingTimer = undefined;
              callback(new Error('远程写入超时'));
            }, sftpWriteChunkTimeoutMs);
            sftp.write(handle, chunk, 0, chunk.length, position, (writeError) => {
              if (pendingTimer) {
                clearTimeout(pendingTimer);
                pendingTimer = undefined;
              }
              if (writeError) {
                callback(writeError);
                return;
              }
              position += chunk.length;
              callback();
            });
          },
          final(callback) {
            handleOpen = false;
            sftp.close(handle, (closeError) => callback(closeError ?? undefined));
          },
          destroy(error, callback) {
            if (pendingTimer) {
              clearTimeout(pendingTimer);
              pendingTimer = undefined;
            }
            if (handleOpen) {
              handleOpen = false;
              sftp.close(handle, () => callback(error));
            } else {
              callback(error);
            }
          }
        });
        const aborted = () => writable.destroy(abortError());
        signal?.addEventListener('abort', aborted, { once: true });
        writable.once('finish', () => signal?.removeEventListener('abort', aborted));
        writable.once('error', () => signal?.removeEventListener('abort', aborted));
        resolve(writable);
      });
    });
  }

  async chmod(remotePath: string, mode: number, signal?: AbortSignal): Promise<void> {
    await callback<void>(
      (done) => this.sftp.chmod(remotePath, mode, done), signal, sftpControlTimeoutMs
    );
  }

  async createDirectory(remotePath: string, signal?: AbortSignal): Promise<void> {
    await callback<void>((done) => this.sftp.mkdir(remotePath, done), signal, sftpControlTimeoutMs);
  }

  async deleteFile(remotePath: string, signal?: AbortSignal): Promise<void> {
    await callback<void>((done) => this.sftp.unlink(remotePath, done), signal, sftpControlTimeoutMs);
  }

  async deleteDirectory(remotePath: string, signal?: AbortSignal): Promise<void> {
    await callback<void>((done) => this.sftp.rmdir(remotePath, done), signal, sftpControlTimeoutMs);
  }

  async rename(
    sourcePath: string,
    targetPath: string,
    overwrite: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    if (overwrite) {
      // SFTP v3 SSH_FXP_RENAME does not mandate overwrite behaviour — some
      // servers reject when the target already exists.  Delete the target
      // first so the rename always succeeds.
      try {
        const stat = await this.stat(targetPath, signal);
        if (stat.type === 'directory') {
          await this.deleteDirectory(targetPath, signal);
        } else {
          await this.deleteFile(targetPath, signal);
        }
      } catch (error) {
        const code = (error as { code?: number | string }).code;
        if (code !== 2 && code !== 'ENOENT') throw error;
      }
    }
    await callback<void>(
      (done) => this.sftp.rename(sourcePath, targetPath, done), signal, sftpControlTimeoutMs
    );
  }

  async close(): Promise<void> {
    this.alive = false;
    this.sftp.end();
    this.client.end();
    await this.releaseRelay?.();
  }
}

async function acquireWslVpnRelay(host: HostConfig): Promise<RelayLease> {
  const script = vpnRelayPoolPath();
  const targetPort = host.port ?? 22;
  const holder = `vscode-sftp-${process.pid}-${host.name}`;
  const command = [
    'source "$1"',
    'vpn_relay_acquire "$2" "$3" "$4"'
  ].join(' && ');
  const { stdout } = await execFileAsync(
    'bash',
    ['-c', command, 'safs-relay', script, host.ip, String(targetPort), holder],
    { timeout: 30_000 }
  );
  const fields = stdout.trim().split(/\s+/);
  const localPort = Number(fields[1]);
  if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65535) {
    throw new Error(`WSL VPN 中继返回了无效端口：${stdout.trim()}`);
  }
  return {
    host: '127.0.0.1',
    port: localPort,
    release: async () => {
      await execFileAsync(
        'bash',
        [
          '-c',
          'source "$1" && vpn_relay_release "$2" "$3" "$4"',
          'safs-relay',
          script,
          host.ip,
          String(targetPort),
          holder
        ],
        { timeout: 30_000 }
      ).then(() => undefined, () => undefined);
    }
  };
}

/** Errors meaning the SFTP subsystem is unusable: the server rejects it or
 * a gateway MOTD/`garbage corrupts the version handshake. These trigger the
 * exec/SCP fallback. */
const sftpUnusablePattern =
  /Unable to start subsystem|packet length|wrong packet|bad packet|exchange encryption keys|Expected VERSION packet|Unknown packet type|Malformed VERSION/i;

/** Handshake-stage errors worth retrying with a fresh connection. */
const retryableHandshakePattern =
  /packet length|wrong packet|bad packet|exchange encryption keys/i;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function connectSftp(
  host: HostConfig,
  useWslVpnRelay = false,
  signal?: AbortSignal,
  clientIdent = defaultSshClientIdent,
  hostVerifier?: HostVerifier,
  onSftpFallback?: (reason: string) => void
): Promise<SftpSession> {
  if (signal?.aborted) throw abortError();
  const relay = useWslVpnRelay && host.vpn ? await acquireWslVpnRelay(host) : undefined;
  let relayReleased = false;
  const releaseRelay = async () => {
    if (relayReleased) return;
    relayReleased = true;
    await relay?.release();
  };
  if (signal?.aborted) {
    await releaseRelay();
    throw abortError();
  }
  const config: ConnectConfig = {
    host: relay?.host ?? host.ip,
    port: relay?.port ?? host.port ?? 22,
    username: host.user,
    password: host.password,
    tryKeyboard: true,
    ident: clientIdent,
    algorithms: { serverHostKey: serverHostKeyAlgorithms },
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    readyTimeout: 30_000,
    // SFTP 是文件数据路径：接入与终端一致的 TOFU 主机密钥校验
    // （hostKeyChangedAction 设置），不再无校验直连。
    ...(hostVerifier ? { hostVerifier } : {})
  };
  if (host.private_key_path) {
    config.privateKey = await readFile(expandHome(host.private_key_path));
  }
  // Some NSG/gateways intermittently inject garbage during the SSH handshake
  // ("Packet length … exceeds max length"). Retry with fresh connections a
  // few times before giving up; the VPN relay stays up across attempts.
  let attempt = 0;
  while (true) {
    try {
      return await attemptConnect(host, config, releaseRelay, signal, onSftpFallback);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!retryableHandshakePattern.test(errorMessage(error)) || attempt >= 2) {
        await releaseRelay();
        throw error;
      }
      attempt++;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
}

function attemptConnect(
  host: HostConfig,
  config: ConnectConfig,
  releaseRelay: () => Promise<void>,
  signal?: AbortSignal,
  onSftpFallback?: (reason: string) => void
): Promise<SftpSession> {
  const client = new Client();
  return new Promise<SftpSession>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      client.removeListener('ready', ready);
      client.removeListener('error', failed);
    };
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      client.end();
      reject(error);
    };
    const failed = (error: Error) => finishError(error);
    const abort = () => finishError(abortError());
    const ready = () => {
      client.sftp((error, sftp) => {
        if (error) {
          // 握手失败时附上通道首字节 hex（由构建期补丁暂存在 client 上），
          // 便于识别网关 banner 的实际格式并精确匹配。
          const probe = (client as unknown as { _safsMotdProbe?: Buffer })._safsMotdProbe;
          const probeDetail = probe && probe.length
            ? `；通道首 64 字节 hex=${probe.subarray(0, 64).toString('hex')}`
            : '';
          // Server has no usable SFTP subsystem: either it rejects the
          // subsystem request (NSG gateways without sftp-server) or a gateway
          // MOTD banner corrupts the SFTP version handshake ("Packet length
          // … exceeds max length"). Fall back to an exec/SCP session on the
          // same connection, reusing the authenticated ssh2 connection.
          if (sftpUnusablePattern.test(error.message)) {
            if (settled) {
              sftp?.end();
              client.end();
              return;
            }
            settled = true;
            cleanup();
            onSftpFallback?.(`${error.message}${probeDetail}`);
            resolve(new ScpSession(host.name, client, releaseRelay));
            return;
          }
          finishError(error);
          return;
        }
        if (settled) {
          sftp.end();
          client.end();
          return;
        }
        settled = true;
        cleanup();
        resolve(new Ssh2SftpSession(host.name, client, sftp, releaseRelay));
      });
    };
    signal?.addEventListener('abort', abort, { once: true });
    // Some servers (e.g. NSG/company gateways) only accept
    // keyboard-interactive auth; answer their prompts with the configured
    // password just like the terminal path does.
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      const replies = host.password
        ? keyboardInteractivePasswordReplies(prompts, host.password)
        : undefined;
      finish(replies ?? []);
    });
    client.once('ready', ready);
    client.once('error', failed);
    try {
      client.connect(config);
    } catch (error) {
      finishError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
