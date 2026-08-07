import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, ConnectConfig, FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
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
    ctime: attributes.atime * 1000,
    permissions: attributes.mode & 0o7777
  };
}

function abortError(): Error {
  const error = new Error('SFTP operation was cancelled');
  error.name = 'AbortError';
  return error;
}

function callback<T>(
  invoke: (done: (error: Error | undefined | null, value: T) => void) => void,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(abortError());
    signal?.addEventListener('abort', aborted, { once: true });
    invoke((error, value) => {
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve(value);
    });
  });
}

export class Ssh2SftpSession implements SftpSession {
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
    return callback((done) => this.sftp.realpath(remotePath, done), signal);
  }

  async stat(remotePath: string, signal?: AbortSignal): Promise<SftpFileStat> {
    return fileStat(await callback((done) => this.sftp.lstat(remotePath, done), signal));
  }

  async readDirectory(
    remotePath: string, signal?: AbortSignal
  ): Promise<SftpDirectoryEntry[]> {
    const entries = await callback<FileEntryWithStats[]>(
      (done) => this.sftp.readdir(remotePath, done),
      signal
    );
    return entries.map((entry) => ({
      name: entry.filename,
      ...fileStat(entry.attrs)
    }));
  }

  readFile(remotePath: string, signal?: AbortSignal): Promise<Uint8Array> {
    return callback<Buffer>((done) => this.sftp.readFile(remotePath, done), signal);
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

  async chmod(remotePath: string, mode: number, signal?: AbortSignal): Promise<void> {
    await callback<void>((done) => this.sftp.chmod(remotePath, mode, done), signal);
  }

  async createDirectory(remotePath: string, signal?: AbortSignal): Promise<void> {
    await callback<void>((done) => this.sftp.mkdir(remotePath, done), signal);
  }

  async deleteFile(remotePath: string, signal?: AbortSignal): Promise<void> {
    await callback<void>((done) => this.sftp.unlink(remotePath, done), signal);
  }

  async deleteDirectory(remotePath: string, signal?: AbortSignal): Promise<void> {
    await callback<void>((done) => this.sftp.rmdir(remotePath, done), signal);
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
    await callback<void>((done) => this.sftp.rename(sourcePath, targetPath, done), signal);
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

/** Errors worth retrying: the gateway returned garbage during the handshake. */
function isRetryableHandshakeError(error: unknown): boolean {
  return /packet length|exchange encryption keys|wrong packet|bad packet/i.test(
    error instanceof Error ? error.message : String(error)
  );
}

export async function connectSftp(
  host: HostConfig,
  useWslVpnRelay = false,
  signal?: AbortSignal,
  clientIdent = defaultSshClientIdent
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
    readyTimeout: 30_000
  };
  if (host.private_key_path) {
    config.privateKey = await readFile(expandHome(host.private_key_path));
  }
  // Some NSG/gateways intermittently inject garbage during the SSH handshake
  // ("Packet length … exceeds max length"). Retry with fresh connections a
  // few times before giving up; the VPN relay stays up across attempts.
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptConnect(host, config, releaseRelay, signal);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (!isRetryableHandshakeError(error) || attempt >= 2) {
        await releaseRelay();
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

function attemptConnect(
  host: HostConfig,
  config: ConnectConfig,
  releaseRelay: () => Promise<void>,
  signal?: AbortSignal
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
          // Server has no SFTP subsystem (e.g. NSG gateway without
          // sftp-server): fall back to an exec/SCP session on the same
          // connection, like MobaXterm's file browser does.
          if (/Unable to start subsystem/i.test(error.message)) {
            if (settled) {
              sftp?.end();
              client.end();
              return;
            }
            settled = true;
            cleanup();
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
