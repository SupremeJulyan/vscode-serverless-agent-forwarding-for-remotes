import { readFile } from 'node:fs/promises';
import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import * as vscode from 'vscode';
import { expandHome, HostConfig } from './config';
import { hostVerifierFor } from './host-key';
import { keyboardInteractivePasswordReplies } from './authentication';
import { shellQuote } from './shell-quote';
import { defaultSshClientIdent, serverHostKeyAlgorithms } from './ssh-algorithms';
import { ssh2RemoteCommand } from './ssh-command';

async function connectConfig(
  host: HostConfig, password?: string
): Promise<ConnectConfig> {
  return {
    host: host.ip,
    port: host.port ?? 22,
    username: host.user,
    ...(password ? { password, tryKeyboard: true } : {}),
    ...(host.private_key_path
      ? { privateKey: await readFile(expandHome(host.private_key_path)) }
      : {}),
    ident: vscode.workspace.getConfiguration('safs')
      .get<string>('sshClientIdent', defaultSshClientIdent),
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    algorithms: { serverHostKey: serverHostKeyAlgorithms },
    hostVerifier: hostVerifierFor(host)
  };
}

export interface Ssh2CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/**
 * 可复用的 ssh2 执行连接（Windows 远程命令路径）：一条 TCP+SSH 连接服务多次
 * exec，避免每条命令重新握手；keepalive 保活；连接死亡后下次调用自动重建。
 */
class Ssh2ExecSession {
  readonly client = new Client();
  readonly ready: Promise<void>;
  private _dead = false;
  private readyReject: ((error: Error) => void) | undefined;

  constructor(
    config: ConnectConfig,
    private readonly password?: string
  ) {
    this.client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      const replies = this.password
        ? keyboardInteractivePasswordReplies(prompts, this.password)
        : undefined;
      finish(replies ?? []);
    });
    // 连接级错误/关闭是持久事件：标记会话失效；ready 之前到来的错误 reject 等待者。
    this.client.on('error', (error: Error) => {
      this._dead = true;
      this.readyReject?.(error);
      this.readyReject = undefined;
    });
    this.client.on('close', () => {
      this._dead = true;
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyReject = reject;
      this.client.once('ready', () => {
        this.readyReject = undefined;
        resolve();
      });
    });
    this.client.connect(config);
  }

  get dead(): boolean {
    return this._dead;
  }

  end(): void {
    this._dead = true;
    // 连接未就绪时被结束：让并发等待 ready 的调用方立即收到错误，避免挂起。
    this.readyReject?.(new Error('SSH 执行连接已结束'));
    this.readyReject = undefined;
    this.client.end();
  }
}

const execSessions = new Map<string, Ssh2ExecSession>();
const creatingExecSessions = new Map<string, Promise<Ssh2ExecSession>>();

function execSessionKey(host: HostConfig): string {
  return `${host.ip}:${host.port ?? 22}:${host.user}`;
}

async function getExecSession(
  host: HostConfig, password?: string
): Promise<Ssh2ExecSession> {
  const key = execSessionKey(host);
  const existing = execSessions.get(key);
  if (existing && !existing.dead) return existing;
  const creating = creatingExecSessions.get(key);
  if (creating) {
    const session = await creating;
    if (!session.dead) return session;
  }
  const promise = (async () => {
    const session = new Ssh2ExecSession(
      await connectConfig(host, password), password
    );
    execSessions.set(key, session);
    return session;
  })();
  creatingExecSessions.set(key, promise);
  try {
    return await promise;
  } finally {
    creatingExecSessions.delete(key);
  }
}

/** 停用时释放全部可复用执行连接。 */
export function closeSsh2ExecSessions(): void {
  for (const session of execSessions.values()) session.end();
  execSessions.clear();
  creatingExecSessions.clear();
}

export async function executeSsh2Command(
  host: HostConfig, password: string | undefined,
  remoteCwd: string, command: string, signal?: AbortSignal, maxOutputBytes = 1024 * 1024
): Promise<Ssh2CommandResult> {
  const session = await getExecSession(host, password);
  await session.ready;
  return new Promise<Ssh2CommandResult>((resolve, reject) => {
    let settled = false;
    let stream: ClientChannel | undefined;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      session.client.removeListener('error', onClientError);
      reject(error);
    };
    const onClientError = (error: Error) => finishError(error);
    const abort = () => {
      if (settled) return;
      if (stream) {
        // 只关闭当前通道，不影响池中其它并发调用。
        stream.close();
      } else {
        // 连接尚未就绪/未开始执行：结束该会话，下次调用重建。
        session.end();
        execSessions.delete(execSessionKey(host));
      }
      finishError(new Error('Remote command was cancelled'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    session.client.on('error', onClientError);
    session.client.exec(ssh2RemoteCommand(remoteCwd, command), (error, execStream) => {
      if (error) {
        finishError(error);
        return;
      }
      stream = execStream;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let capturedBytes = 0;
      let truncated = false;
      const capture = (target: Buffer[], chunk: Buffer) => {
        const remaining = maxOutputBytes - capturedBytes;
        if (remaining > 0) {
          target.push(chunk.subarray(0, remaining));
          capturedBytes += Math.min(chunk.length, remaining);
        }
        if (chunk.length > remaining) truncated = true;
      };
      execStream.on('data', (chunk: Buffer) => capture(stdout, chunk));
      execStream.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
      execStream.once('close', (code: number | undefined) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        session.client.removeListener('error', onClientError);
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
          truncated
        });
      });
    });
  });
}

export class Ssh2Terminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidClose = this.closeEmitter.event;
  private readonly client = new Client();
  private stream?: ClientChannel;
  private dimensions: vscode.TerminalDimensions = { columns: 80, rows: 24 };
  private password?: string;
  private closed = false;
  /** 待 shell 通道就绪后补发的输入（live-sync 的 cd 可能早于连接完成）。 */
  private pendingInput = '';

  constructor(
    private readonly host: HostConfig,
    password: string,
    private readonly remoteCwd?: string,
    private readonly onFailed?: (error: Error) => void,
    private readonly log?: (message: string) => void
  ) {
    this.password = password;
  }

  open(initialDimensions?: vscode.TerminalDimensions): void {
    if (initialDimensions) this.dimensions = initialDimensions;
    this.writeEmitter.fire(`SAFS: 正在连接 ${this.host.name}…\r\n`);
    const config: ConnectConfig = {
      host: this.host.ip,
      port: this.host.port ?? 22,
      username: this.host.user,
      password: this.password,
      tryKeyboard: true,
      ident: vscode.workspace.getConfiguration('safs')
        .get<string>('sshClientIdent', defaultSshClientIdent),
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      algorithms: { serverHostKey: serverHostKeyAlgorithms },
      hostVerifier: hostVerifierFor(this.host, this.log)
    };
    this.client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      const replies = this.password
        ? keyboardInteractivePasswordReplies(prompts, this.password)
        : undefined;
      finish(replies ?? []);
    });
    this.client.once('ready', () => {
      this.password = undefined;
      // Run the cd as part of the remote command (with a pty) instead of
      // typing it into the shell: `ssh -t host "cd -- '…' && exec …"` does
      // not echo the cd, whereas typing it into an interactive shell does.
      const loginCommand = this.remoteCwd
        ? `cd -- ${shellQuote(this.remoteCwd)} && exec "\${SHELL:-/bin/sh}" -l`
        : `exec "\${SHELL:-/bin/sh}" -l`;
      this.client.exec(loginCommand, {
        pty: {
          term: 'xterm-256color',
          cols: this.dimensions.columns,
          rows: this.dimensions.rows
        }
      }, (error, stream) => {
        if (error) {
          this.fail(error);
          return;
        }
        this.stream = stream;
        stream.on('data', (chunk: Buffer) => this.writeEmitter.fire(chunk.toString()));
        stream.stderr.on('data', (chunk: Buffer) => this.writeEmitter.fire(chunk.toString()));
        stream.once('close', () => this.finish(0));
        // 补发连接建立期间排队（live-sync）的输入，避免 cd 被丢弃。
        if (this.pendingInput) {
          stream.write(this.pendingInput);
          this.pendingInput = '';
        }
      });
    });
    this.client.once('error', (error) => this.fail(error));
    this.client.connect(config);
  }

  handleInput(data: string): void {
    this.stream?.write(data);
  }

  /**
   * 写入远程终端；shell 通道尚未建立时先入队，建立后补发。
   * 供 live-sync（终端跟随打开文件）在 SSH 连接完成前安全调用。
   */
  sendInput(data: string): void {
    if (this.stream) {
      this.stream.write(data);
    } else {
      this.pendingInput += data;
    }
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.dimensions = dimensions;
    this.stream?.setWindow(dimensions.rows, dimensions.columns, 0, 0);
  }

  close(): void {
    this.password = undefined;
    this.stream?.close();
    this.client.end();
  }

  private fail(error: Error): void {
    this.onFailed?.(error);
    this.writeEmitter.fire(`\r\nSAFS: ${error.message}\r\n`);
    this.finish(1);
  }

  private finish(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.password = undefined;
    this.client.end();
    this.closeEmitter.fire(code);
  }
}
