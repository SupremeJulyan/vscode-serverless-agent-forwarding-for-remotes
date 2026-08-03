import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, ClientChannel, ConnectConfig, HostVerifier } from 'ssh2';
import * as vscode from 'vscode';
import { expandHome, HostConfig } from './config';
import { keyboardInteractivePasswordReplies } from './authentication';
import { ssh2RemoteCommand } from './ssh-command';

const trustedHostKeysState = 'safs.trustedSsh2HostKeys';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function hostVerifierFor(
  context: vscode.ExtensionContext, host: HostConfig
): HostVerifier {
  const port = host.port ?? 22;
  const trustKey = `${host.ip}:${port}`;
  return (key, callback) => {
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
    const trusted = context.globalState.get<Record<string, string>>(trustedHostKeysState, {});
    if (trusted[trustKey] === fingerprint) {
      callback(true);
      return;
    }
    if (trusted[trustKey]) {
      void vscode.window.showErrorMessage(
        `主机"${host.name}"的 SSH 主机密钥已改变，已拒绝连接。`, { modal: true }
      );
      callback(false);
      return;
    }
    void vscode.window.showWarningMessage(
      `首次连接主机"${host.name}"。是否信任 SSH 主机密钥 ${fingerprint}？`,
      { modal: true }, '信任并连接'
    ).then(async (choice) => {
      if (choice !== '信任并连接') {
        callback(false);
        return;
      }
      await context.globalState.update(trustedHostKeysState, {
        ...trusted, [trustKey]: fingerprint
      });
      callback(true);
    });
  };
}

async function connectConfig(
  context: vscode.ExtensionContext, host: HostConfig, password?: string
): Promise<ConnectConfig> {
  return {
    host: host.ip,
    port: host.port ?? 22,
    username: host.user,
    ...(password ? { password, tryKeyboard: true } : {}),
    ...(host.private_key_path
      ? { privateKey: await readFile(expandHome(host.private_key_path)) }
      : {}),
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    hostVerifier: hostVerifierFor(context, host)
  };
}

export interface Ssh2CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export async function executeSsh2Command(
  context: vscode.ExtensionContext, host: HostConfig, password: string | undefined,
  remoteCwd: string, command: string, signal?: AbortSignal, maxOutputBytes = 1024 * 1024
): Promise<Ssh2CommandResult> {
  const client = new Client();
  const config = await connectConfig(context, host, password);
  return new Promise<Ssh2CommandResult>((resolve, reject) => {
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      client.end();
      reject(error);
    };
    const abort = () => finishError(new Error('Remote command was cancelled'));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      const replies = password ? keyboardInteractivePasswordReplies(prompts, password) : undefined;
      finish(replies ?? []);
    });
    client.once('error', finishError);
    client.once('ready', () => {
      client.exec(ssh2RemoteCommand(remoteCwd, command), (error, stream) => {
        if (error) {
          finishError(error);
          return;
        }
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
        stream.on('data', (chunk: Buffer) => capture(stdout, chunk));
        stream.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
        stream.once('close', (code: number | undefined) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', abort);
          client.end();
          resolve({
            exitCode: code ?? 1,
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
            truncated
          });
        });
      });
    });
    client.connect(config);
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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: HostConfig,
    password: string,
    private readonly remoteCwd?: string
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
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      hostVerifier: hostVerifierFor(this.context, this.host)
    };
    this.client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      const replies = this.password
        ? keyboardInteractivePasswordReplies(prompts, this.password)
        : undefined;
      finish(replies ?? []);
    });
    this.client.once('ready', () => {
      this.password = undefined;
      this.client.shell({
        term: 'xterm-256color', cols: this.dimensions.columns, rows: this.dimensions.rows
      }, (error, stream) => {
        if (error) {
          this.fail(error);
          return;
        }
        this.stream = stream;
        stream.on('data', (chunk: Buffer) => this.writeEmitter.fire(chunk.toString()));
        stream.stderr.on('data', (chunk: Buffer) => this.writeEmitter.fire(chunk.toString()));
        stream.once('close', () => this.finish(0));
        if (this.remoteCwd) stream.write(`cd -- ${shellQuote(this.remoteCwd)}\r`);
      });
    });
    this.client.once('error', (error) => this.fail(error));
    this.client.connect(config);
  }

  handleInput(data: string): void {
    this.stream?.write(data);
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
