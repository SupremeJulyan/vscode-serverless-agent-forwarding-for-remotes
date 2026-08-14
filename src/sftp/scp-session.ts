import * as path from 'node:path';
import { Client } from 'ssh2';
import {
  SftpDirectoryEntry, SftpFileStat, SftpFileType, SftpSession, SftpWriteOptions
} from './session';

/**
 * Exec/SCP-backed session used when the server has no SFTP subsystem
 * (e.g. NSG gateways running old OpenSSH without sftp-server). This is the
 * same mechanism MobaXterm's file browser falls back to: it reuses the
 * authenticated ssh2 connection and speaks the legacy SCP protocol plus plain
 * shell commands over exec channels.
 *
 * Implements the same SftpSession interface as the SFTP client so the
 * filesystem provider and MCP tools keep working unchanged.
 */

interface ExecResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function abortError(): Error {
  const error = new Error('SFTP operation was cancelled');
  error.name = 'AbortError';
  return error;
}

function errno(code: number, message: string): Error & { code: number } {
  const error = new Error(message) as Error & { code: number };
  error.code = code;
  return error;
}

function missingPathDetail(stderr: string): string {
  return /no such file or directory|not found/i.test(stderr)
    ? stderr.trim()
    : stderr.trim() || '远程命令执行失败';
}

/**
 * Some NSG gateways inject a fixed MOTD banner at the start of every SSH
 * channel, e.g.:
 *   \r \r … 一×17\n \|用户类型:包时间用户\n \|核数:128\n
 *   \|到期时间:2029/07/02\n 一×17\r\n
 * It is pure text, so shell output still works, but it corrupts binary
 * protocols (SFTP version packets, SCP headers) by prefixing garbage.
 * Detect it by its leading "\r \r" signature and strip up to the box-bottom
 * line (a 一 run followed by CRLF) before parsing the real payload.
 */
const motdSignature = Buffer.from([0x0d, 0x20, 0x0d, 0x20]);
const motdTerminator = Buffer.from([0xe4, 0xb8, 0x80, 0x0d, 0x0a]); // 一 + CRLF

/**
 * Incremental variant for streaming channels: feeds chunks, strips the MOTD
 * prefix once its terminator is observed, then forwards the payload.
 */
class MotdStripper {
  private pending = Buffer.alloc(0);
  private done = false;
  /** MOTD 探测上限：超过该长度仍未见到终止符则视为无 MOTD，把缓冲内容作为载荷放行，
   * 避免对不以 MOTD 开头的（异常）数据流无限累积导致 O(n²) 拷贝。 */
  private static readonly maxProbeLength = 256 * 1024;

  push(chunk: Buffer): Buffer[] {
    if (this.done) return [chunk];
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length < 4) return [];
    if (!this.pending.subarray(0, 4).equals(motdSignature)) {
      this.done = true;
      const out = this.pending;
      this.pending = Buffer.alloc(0);
      return [out];
    }
    const idx = this.pending.indexOf(motdTerminator);
    if (idx === -1) {
      if (this.pending.length >= MotdStripper.maxProbeLength) {
        this.done = true;
        const out = this.pending;
        this.pending = Buffer.alloc(0);
        return [out];
      }
      return [];
    }
    this.done = true;
    const out = this.pending.subarray(idx + motdTerminator.length);
    this.pending = Buffer.alloc(0);
    return [out];
  }
}

/** Map a remote command's stderr to an SFTP-like status code for the provider. */
function failureCode(stderr: string): number {
  if (/no such file|not found|does not exist/i.test(stderr)) return 2;
  if (/permission denied|denied|not permitted/i.test(stderr)) return 3;
  return 5;
}

function typeFromFindLetter(letter: string): SftpFileType {
  switch (letter) {
    case 'f': return 'file';
    case 'd': return 'directory';
    case 'l': return 'symbolic-link';
    default: return 'unknown';
  }
}

function typeFromStatName(name: string): SftpFileType {
  if (/^regular file/.test(name)) return 'file';
  if (/^directory/.test(name)) return 'directory';
  if (/^symbolic link/.test(name)) return 'symbolic-link';
  return 'unknown';
}

const modeRe = /^([dls-])([rwxstST-]{9})(?:[+.@])?(?:\s|$)/;

function parseLsLongLine(line: string): SftpFileStat | undefined {
  // long-iso ls line:  -rw-r--r-- 1 user group 1234 2006-04-17 14:53 name
  const trimmed = line.trim();
  const modeMatch = modeRe.exec(trimmed);
  if (!modeMatch) return undefined;
  const afterMode = trimmed.slice(modeMatch[0].length).trimStart();
  const fields = afterMode.split(/\s+/);
  // fields: [links, owner, group, size, date, time, name...]
  if (fields.length < 7) return undefined;
  const size = Number(fields[3]);
  const mtime = Date.parse(`${fields[4]} ${fields[5]}`);
  let type: SftpFileType = 'file';
  if (modeMatch[1] === 'd') type = 'directory';
  else if (modeMatch[1] === 'l') type = 'symbolic-link';
  let permissions = 0;
  const modeString = modeMatch[2];
  for (let i = 0; i < 9; i++) {
    if (modeString[i] !== '-') permissions |= 1 << (8 - i);
  }
  return { type, size: Number.isFinite(size) ? size : 0, mtime, ctime: mtime, permissions };
}

function parseLsLongEntry(line: string): SftpDirectoryEntry | undefined {
  const stat = parseLsLongLine(line);
  if (!stat) return undefined;
  const trimmed = line.trim();
  const modeMatch = modeRe.exec(trimmed)!;
  const afterMode = trimmed.slice(modeMatch[0].length).trimStart();
  const fields = afterMode.split(/\s+/);
  // fields: [links, owner, group, size, date, time, name...]
  const name = fields.slice(6).join(' ');
  if (!name) return undefined;
  return { ...stat, name };
}

export class ScpSession implements SftpSession {
  readonly transport = 'scp' as const;
  private alive = true;
  // The gateway (old OpenSSH/NSG) rejects excess concurrent channels on one
  // connection with "(SSH) Channel open failure: open failed". Serialize
  // channel-opening operations so VS Code's parallel explorer/stat/watch
  // calls stay under the server's per-connection limit.
  private static readonly maxConcurrentChannels = 5;
  private channelPermits = ScpSession.maxConcurrentChannels;
  private readonly channelWaiters: Array<() => void> = [];

  constructor(
    readonly hostName: string,
    private readonly client: Client,
    private readonly releaseRelay?: () => Promise<void>
  ) {
    const disconnected = () => {
      this.alive = false;
    };
    this.client.on('close', disconnected);
    this.client.on('end', disconnected);
    this.client.on('error', () => {
      this.alive = false;
    });
  }

  isAlive(): boolean {
    return this.alive;
  }

  private async acquireChannel(): Promise<void> {
    while (this.channelPermits <= 0) {
      await new Promise<void>((resolve) => this.channelWaiters.push(resolve));
    }
    this.channelPermits--;
  }

  private releaseChannel(): void {
    this.channelPermits++;
    this.channelWaiters.shift()?.();
  }

  private async exec(
    command: string, stdinData?: Uint8Array, signal?: AbortSignal
  ): Promise<ExecResult> {
    await this.acquireChannel();
    try {
      return await this.execUnbounded(command, stdinData, signal);
    } finally {
      this.releaseChannel();
    }
  }

  private async execUnbounded(
    command: string, stdinData?: Uint8Array, signal?: AbortSignal
  ): Promise<ExecResult> {
    // Transient server-side channel refusal: retry once after a short pause.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.execOnce(command, stdinData, signal);
      } catch (error) {
        const retryable = /Channel open failure|channel open failed/i.test(
          error instanceof Error ? error.message : String(error)
        );
        if (!retryable || attempt >= 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  private execOnce(
    command: string, stdinData?: Uint8Array, signal?: AbortSignal
  ): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      let settled = false;
      const aborted = () => {
        if (!settled) {
          settled = true;
          reject(abortError());
        }
      };
      signal?.addEventListener('abort', aborted, { once: true });
      this.client.exec(command, (error, stream) => {
        if (error) {
          if (!settled) {
            settled = true;
            signal?.removeEventListener('abort', aborted);
            reject(error);
          }
          return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const motdStripper = new MotdStripper();
        stream.on('data', (chunk: Buffer) => {
          for (const part of motdStripper.push(chunk)) stdout.push(part);
        });
        stream.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        stream.once('close', (code: number | undefined) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', aborted);
          resolve({
            code: code ?? -1,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr)
          });
        });
        if (stdinData && stdinData.length) stream.stdin.write(Buffer.from(stdinData));
        stream.stdin.end();
      });
    });
  }

  async realpath(remotePath: string, signal?: AbortSignal): Promise<string> {
    // readlink -f canonicalizes files AND directories; the provider resolves
    // every path (including files) before reading/stat-ing it. Note: old
    // coreutils readlink -f still succeeds when only the final component is
    // missing — subsequent stat then reports ENOENT, which matches SFTP.
    const result = await this.exec(
      `readlink -f -- ${shellQuote(remotePath)}`, undefined, signal
    );
    if (result.code === 0) {
      const resolved = result.stdout.toString().trim();
      if (resolved) return resolved;
    }
    // Non-GNU servers (BSD/macOS/Solaris) lack `readlink -f`: fall back to
    // `cd`+`pwd -P` for directories, then to a plain normalized path for
    // files that exist.
    const cdResult = await this.exec(
      `cd -- ${shellQuote(remotePath)} && pwd -P`, undefined, signal
    );
    if (cdResult.code === 0) {
      const resolved = cdResult.stdout.toString().trim();
      if (resolved) return resolved;
    }
    const exists = await this.exec(
      `test -e -- ${shellQuote(remotePath)}`, undefined, signal
    );
    if (exists.code === 0) {
      return path.posix.normalize(remotePath);
    }
    const stderr = result.stderr.toString() || cdResult.stderr.toString();
    throw errno(failureCode(stderr), `realpath 失败: ${missingPathDetail(stderr)}`);
  }

  async stat(remotePath: string, signal?: AbortSignal): Promise<SftpFileStat> {
    const result = await this.exec(
      `stat -c '%F|%s|%a|%Y' -- ${shellQuote(remotePath)}`, undefined, signal
    );
    if (result.code === 0) {
      const parts = result.stdout.toString().trim().split('|');
      if (parts.length >= 4) {
        const mtime = Number(parts[3]) * 1000;
        return {
          type: typeFromStatName(parts[0]),
          size: Number(parts[1]),
          permissions: parseInt(parts[2], 8),
          mtime: Number.isFinite(mtime) ? mtime : Date.now(),
          ctime: Number.isFinite(mtime) ? mtime : Date.now()
        };
      }
    }
    // Fallback: ls -ld --time-style=long-iso
    const ls = await this.exec(
      `ls -ld --time-style=long-iso -- ${shellQuote(remotePath)}`, undefined, signal
    );
    if (ls.code !== 0) {
      const stderr = ls.stderr.toString();
      throw errno(failureCode(stderr), `stat 失败: ${missingPathDetail(stderr)}`);
    }
    const parsed = parseLsLongLine(ls.stdout.toString());
    if (!parsed) throw new Error(`无法解析远程 stat 输出: ${ls.stdout.toString().trim()}`);
    return parsed;
  }

  async readDirectory(
    remotePath: string, signal?: AbortSignal
  ): Promise<SftpDirectoryEntry[]> {
    const result = await this.exec(
      `find ${shellQuote(remotePath)} -maxdepth 1 -mindepth 1 -printf '%f|%y|%s|%m|%T@\\n'`,
      undefined,
      signal
    );
    if (result.code === 0 && result.stdout.length > 0) {
      const entries: SftpDirectoryEntry[] = [];
      for (const line of result.stdout.toString().split('\n')) {
        if (!line) continue;
        const parts = line.split('|');
        if (parts.length < 5) continue;
        const mtime = Math.floor(parseFloat(parts[4]) * 1000);
        entries.push({
          name: parts[0],
          type: typeFromFindLetter(parts[1]),
          size: Number(parts[2]),
          permissions: parseInt(parts[3], 8),
          mtime: Number.isFinite(mtime) ? mtime : Date.now(),
          ctime: Number.isFinite(mtime) ? mtime : Date.now()
        });
      }
      if (entries.length > 0) return entries;
    }
    // Non-GNU servers lack `find -printf`: fall back to `ls -la` parsing.
    const ls = await this.exec(
      `ls -la --time-style=long-iso -- ${shellQuote(remotePath)}`, undefined, signal
    );
    if (ls.code !== 0) {
      const stderr = result.code === 0 ? ls.stderr.toString() : result.stderr.toString();
      throw errno(failureCode(stderr), `readDirectory 失败: ${missingPathDetail(stderr)}`);
    }
    const entries: SftpDirectoryEntry[] = [];
    for (const line of ls.stdout.toString().split('\n')) {
      const parsed = parseLsLongEntry(line);
      if (!parsed || parsed.name === '.' || parsed.name === '..') continue;
      entries.push(parsed);
    }
    return entries;
  }

  async readFile(remotePath: string, signal?: AbortSignal): Promise<Uint8Array> {
    return this.scpRead(remotePath, signal);
  }

  async writeFile(
    remotePath: string,
    content: Uint8Array,
    options: SftpWriteOptions,
    signal?: AbortSignal
  ): Promise<void> {
    if (options.create && !options.overwrite) {
      if (await this.pathExists(remotePath, signal)) {
        throw errno(4, `文件已存在: ${remotePath}`);
      }
    } else if (!options.create) {
      if (!(await this.pathExists(remotePath, signal))) {
        throw errno(2, `文件不存在: ${remotePath}`);
      }
    }
    let mode = 0o644;
    if (options.overwrite) {
      try {
        const existing = await this.stat(remotePath, signal);
        if (existing.permissions !== undefined) mode = existing.permissions;
      } catch {
        // new file: default mode
      }
    }
    await this.scpWrite(
      path.posix.dirname(remotePath),
      path.posix.basename(remotePath),
      Buffer.from(content),
      mode,
      signal
    );
  }

  async chmod(remotePath: string, mode: number, signal?: AbortSignal): Promise<void> {
    const result = await this.exec(
      `chmod ${mode.toString(8)} -- ${shellQuote(remotePath)}`, undefined, signal
    );
    if (result.code !== 0) {
      throw new Error(`chmod 失败: ${missingPathDetail(result.stderr.toString())}`);
    }
  }

  async createDirectory(remotePath: string, signal?: AbortSignal): Promise<void> {
    const result = await this.exec(
      `mkdir -p -- ${shellQuote(remotePath)}`, undefined, signal
    );
    if (result.code !== 0) {
      throw new Error(`mkdir 失败: ${missingPathDetail(result.stderr.toString())}`);
    }
  }

  async deleteFile(remotePath: string, signal?: AbortSignal): Promise<void> {
    const result = await this.exec(
      `rm -f -- ${shellQuote(remotePath)}`, undefined, signal
    );
    if (result.code !== 0) {
      throw new Error(`rm 失败: ${missingPathDetail(result.stderr.toString())}`);
    }
  }

  async deleteDirectory(remotePath: string, signal?: AbortSignal): Promise<void> {
    const result = await this.exec(
      `rmdir -- ${shellQuote(remotePath)}`, undefined, signal
    );
    if (result.code !== 0) {
      throw new Error(`rmdir 失败: ${missingPathDetail(result.stderr.toString())}`);
    }
  }

  async rename(
    sourcePath: string,
    targetPath: string,
    overwrite: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    if (overwrite) {
      // Remove the existing target first (SFTP semantics); a plain `mv -f`
      // would move into a directory if the target happens to be one.
      const exists = await this.pathExists(targetPath, signal);
      if (exists) {
        const targetStat = await this.stat(targetPath, signal);
        const remove = targetStat.type === 'directory'
          ? `rmdir -- ${shellQuote(targetPath)}`
          : `rm -f -- ${shellQuote(targetPath)}`;
        const removed = await this.exec(remove, undefined, signal);
        if (removed.code !== 0 && !/no such file/i.test(removed.stderr.toString())) {
          throw new Error(`无法替换目标文件: ${missingPathDetail(removed.stderr.toString())}`);
        }
      }
    }
    const result = await this.exec(
      `mv -- ${shellQuote(sourcePath)} ${shellQuote(targetPath)}`, undefined, signal
    );
    if (result.code !== 0) {
      throw new Error(`mv 失败: ${missingPathDetail(result.stderr.toString())}`);
    }
  }

  async close(): Promise<void> {
    this.alive = false;
    this.client.end();
    await this.releaseRelay?.();
  }

  private async pathExists(remotePath: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.stat(remotePath, signal);
      return true;
    } catch {
      return false;
    }
  }

  /** Legacy SCP download: `scp -f <path>`, parse the C<mode> <size> <name> header. */
  private async scpRead(remotePath: string, signal?: AbortSignal): Promise<Uint8Array> {
    await this.acquireChannel();
    try {
      return await this.scpReadUnbounded(remotePath, signal);
    } finally {
      this.releaseChannel();
    }
  }

  private scpReadUnbounded(remotePath: string, signal?: AbortSignal): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      let settled = false;
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          signal?.removeEventListener('abort', aborted);
          reject(error);
        }
      };
      const aborted = () => fail(abortError());
      signal?.addEventListener('abort', aborted, { once: true });
      this.client.exec(`scp -f -- ${shellQuote(remotePath)}`, (error, stream) => {
        if (error) {
          fail(error);
          return;
        }
        const stderrChunks: Buffer[] = [];
        stream.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
        const fileChunks: Buffer[] = [];
        let buffer = Buffer.alloc(0);
        let state: 'header' | 'data' | 'term' = 'header';
        let expected = 0;
        const motdStripper = new MotdStripper();
        stream.on('data', (chunk: Buffer) => {
          for (const part of motdStripper.push(chunk)) {
            buffer = Buffer.concat([buffer, part]);
          }
          if (state === 'header') {
            const newline = buffer.indexOf(0x0a);
            if (newline === -1) return;
            const line = buffer.subarray(0, newline).toString('latin1');
            buffer = buffer.subarray(newline + 1);
            const match = /^C(\d{4}) (\d+) (.*)$/.exec(line);
            if (!match) {
              fail(new Error(`SCP 响应无效: ${line.slice(0, 200)}`));
              return;
            }
            expected = Number(match[2]);
            state = 'data';
            // Legacy SCP protocol: the sender waits for an OK byte after the
            // C header before streaming the file data.
            stream.stdin.write(Buffer.from([0]));
          }
          if (state === 'data') {
            if (buffer.length >= expected) {
              fileChunks.push(buffer.subarray(0, expected));
              buffer = buffer.subarray(expected);
              state = 'term';
            } else {
              fileChunks.push(buffer);
              buffer = Buffer.alloc(0);
            }
          }
          if (state === 'term') {
            if (buffer.length >= 1) {
              if (buffer[0] !== 0) {
                fail(new Error('SCP 文件传输结束符无效'));
                return;
              }
              stream.stdin.write(Buffer.from([0]));
              stream.stdin.end();
              if (!settled) {
                settled = true;
                signal?.removeEventListener('abort', aborted);
                resolve(Buffer.concat(fileChunks));
              }
            }
          }
        });
        stream.once('close', () => {
          if (!settled) {
            const detail = Buffer.concat(stderrChunks).toString().trim();
            fail(new Error(detail ? `SCP 读取失败: ${detail}` : 'SCP 读取失败：连接提前关闭'));
          }
        });
        // Receiver asks the sender to start with an OK byte.
        stream.stdin.write(Buffer.from([0]));
      });
    });
  }

  /** Legacy SCP upload: `scp -t <dir>`, send `C<mode> <size> <name>` + data. */
  private async scpWrite(
    targetDir: string, baseName: string, content: Buffer, mode: number, signal?: AbortSignal
  ): Promise<void> {
    await this.acquireChannel();
    try {
      return await this.scpWriteUnbounded(targetDir, baseName, content, mode, signal);
    } finally {
      this.releaseChannel();
    }
  }

  private scpWriteUnbounded(
    targetDir: string, baseName: string, content: Buffer, mode: number, signal?: AbortSignal
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      let settled = false;
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          signal?.removeEventListener('abort', aborted);
          reject(error);
        }
      };
      const aborted = () => fail(abortError());
      signal?.addEventListener('abort', aborted, { once: true });
      this.client.exec(`scp -t -- ${shellQuote(targetDir)}`, (error, stream) => {
        if (error) {
          fail(error);
          return;
        }
        const stderrChunks: Buffer[] = [];
        stream.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
        let buffer = Buffer.alloc(0);
        let acknowledged = false;
        const motdStripper = new MotdStripper();
        stream.on('data', (chunk: Buffer) => {
          for (const part of motdStripper.push(chunk)) {
            buffer = Buffer.concat([buffer, part]);
          }
          if (!acknowledged && buffer.length >= 1) {
            if (buffer[0] !== 0) {
              const detail = Buffer.concat(stderrChunks).toString().trim();
              fail(new Error(detail ? `SCP 目标未就绪: ${detail}` : 'SCP 目标未就绪'));
              return;
            }
            buffer = buffer.subarray(1);
            acknowledged = true;
            const modeString = mode.toString(8).padStart(4, '0');
            const header = `C${modeString} ${content.length} ${baseName}\n`;
            const payload = Buffer.concat([
              Buffer.from(header, 'latin1'), content, Buffer.from([0])
            ]);
            stream.stdin.write(payload);
            stream.stdin.end();
          }
          if (acknowledged && buffer.length >= 1) {
            if (buffer[0] !== 0) {
              fail(new Error('SCP 写入确认失败'));
              return;
            }
            if (!settled) {
              settled = true;
              signal?.removeEventListener('abort', aborted);
              resolve();
            }
          }
        });
        stream.once('close', () => {
          if (!settled) {
            const detail = Buffer.concat(stderrChunks).toString().trim();
            fail(new Error(detail ? `SCP 写入失败: ${detail}` : 'SCP 写入失败：连接提前关闭'));
          }
        });
      });
    });
  }
}
