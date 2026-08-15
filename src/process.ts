import { execFile, spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { CommandPlan } from './platform';

const execFileAsync = promisify(execFile);

export function missingExecutableName(error: unknown): string | undefined {
  if (error instanceof Error) {
    const nodeError = error as NodeJS.ErrnoException & { path?: string; syscall?: string };
    if (nodeError.code === 'ENOENT' && nodeError.syscall?.startsWith('spawn')) {
      return nodeError.path || /^spawn\s+(.+?)\s+ENOENT$/i.exec(error.message)?.[1];
    }
    return /(?:^|:\s*)spawn\s+(.+?)\s+ENOENT(?:$|\s)/i.exec(error.message)?.[1];
  }
  return /(?:^|:\s*)spawn\s+(.+?)\s+ENOENT(?:$|\s)/i.exec(String(error))?.[1];
}

export function commandSearchPath(
  home = os.homedir(), inheritedPath = process.env.PATH
): string {
  const localBin = path.join(home, '.local', 'bin');
  return inheritedPath ? `${localBin}${path.delimiter}${inheritedPath}` : localBin;
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('where.exe', [command], { windowsHide: true });
    } else {
      await execFileAsync(
        'sh', ['-lc', `command -v "$1" >/dev/null 2>&1`, 'sh', command],
        { env: { ...process.env, PATH: commandSearchPath() } }
      );
    }
    return true;
  } catch {
    return false;
  }
}

const resolvedCache = new Map<string, string>();

/**
 * Windows 下把裸命令名解析为真实路径（经 `where.exe`）。
 *
 * npm 全局安装的 CLI（codex/claude 等）在 PATH 上通常只有 `*.cmd`/`*.bat`
 * shim：`where.exe` 能找到它们，但 Node 的 `spawn` 不能直接执行 `.cmd`/`.bat`
 * （会抛 `spawn <cmd> ENOENT`）。这里优先返回真实 `.exe`/`.com`；只有 shim
 * 时返回 `.cmd`/`.bat` 路径，由 `windowsCommandInvocation` 经 `cmd.exe` 执行；
 * 找不到时返回原命令名，让调用方保持原有 ENOENT 语义。
 */
async function resolveWindowsExecutable(
  command: string, env?: NodeJS.ProcessEnv
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'where.exe', [command],
      { env: { ...process.env, ...env }, windowsHide: true }
    );
    const candidates = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const executable = candidates.find((candidate) => /\.(exe|com)$/i.test(candidate));
    if (executable) return executable;
    const script = candidates.find((candidate) => /\.(cmd|bat)$/i.test(candidate));
    if (script) return script;
    if (candidates.length > 0) return candidates[0];
    return command;
  } catch {
    return command;
  }
}

export async function resolveExecutable(command: string, env?: NodeJS.ProcessEnv): Promise<string> {
  if (command.includes('/') || command.includes('\\')) return command;
  const cacheKey = JSON.stringify({ command, path: env?.PATH });
  const cached = resolvedCache.get(cacheKey);
  if (cached !== undefined) return cached;
  if (process.platform === 'win32') {
    const resolved = await resolveWindowsExecutable(command, env);
    resolvedCache.set(cacheKey, resolved);
    return resolved;
  }
  try {
    const { stdout } = await execFileAsync(
      'sh', ['-lc', 'command -v "$1"', 'sh', command],
      {
        env: {
          ...process.env,
          ...env,
          PATH: commandSearchPath(
            os.homedir(), env?.PATH ?? process.env.PATH
          )
        }
      }
    );
    const resolved = stdout.trim().split(/\r?\n/, 1)[0];
    const result = resolved.startsWith('/') ? resolved : command;
    resolvedCache.set(cacheKey, result);
    return result;
  } catch {
    resolvedCache.set(cacheKey, command);
    return command;
  }
}

export interface WindowsCommandInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/**
 * 按 cmd.exe 规则转义单个参数。`& | < > ^` 在引号内是字面量；`%`（变量展开）
 * 与 `!`（延迟展开）即使在引号内也特殊，SAFS 传参是内部生成的 MCP server 名
 * 与固定路由 URL（hex token），不含这些字符；保守起见仍对含引号/空格/元字符
 * 的参数整体加引号，并把内部引号双写为 cmd 转义形式。
 */
function windowsCmdQuotedArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[ \t\n&|<>^"%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Windows 下 `.cmd`/`.bat` shim 不能直接 spawn（Node 抛 ENOENT），统一改经
 * `cmd.exe /d /s /c` 执行；其余命令（含 `ssh.exe`、`wsl.exe` 等真实可执行文件）
 * 原样返回。非 Windows 平台一律原样返回。
 */
export function windowsCommandInvocation(
  command: string, args: string[]
): WindowsCommandInvocation {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) {
    return { command, args, windowsVerbatimArguments: false };
  }
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `${command} ${args.map(windowsCmdQuotedArg).join(' ')}`],
    windowsVerbatimArguments: true
  };
}

export async function commandSucceeds(plan: CommandPlan): Promise<boolean> {
  try {
    const command = await resolveExecutable(plan.command, plan.env);
    const invocation = windowsCommandInvocation(command, plan.args);
    await execFileAsync(invocation.command, invocation.args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      ...(invocation.windowsVerbatimArguments
        ? { windowsVerbatimArguments: true }
        : {})
    });
    return true;
  } catch {
    return false;
  }
}

export interface ProcessOutputHandlers {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
}

export interface CapturedProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export async function executeCaptured(
  plan: CommandPlan, signal?: AbortSignal, maxOutputBytes = 1024 * 1024,
  handlers: ProcessOutputHandlers = {}
): Promise<CapturedProcessResult> {
  const command = await resolveExecutable(plan.command, plan.env);
  const invocation = windowsCommandInvocation(command, plan.args);
  return new Promise<CapturedProcessResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(invocation.windowsVerbatimArguments
        ? { windowsVerbatimArguments: true }
        : {})
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = maxOutputBytes - capturedBytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        target.push(kept);
        capturedBytes += kept.length;
      }
      if (chunk.length > remaining) truncated = true;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      capture(stdout, chunk);
      handlers.stdout?.(chunk.toString());
    });
    child.stderr.on('data', (chunk: Buffer) => {
      capture(stderr, chunk);
      handlers.stderr?.(chunk.toString());
    });
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort);
      resolve({
        exitCode: code ?? (signal?.aborted ? 130 : 1),
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        truncated
      });
    });
    child.stdin.end(plan.stdin);
  });
}

export async function executeWithStdin(
  plan: CommandPlan, handlers: ProcessOutputHandlers = {}
): Promise<void> {
  // VS Code's extension host can have an older PATH than its login shell.
  // Resolve bridge tools through that shell before spawning them directly.
  const command = await resolveExecutable(plan.command, plan.env);
  const invocation = windowsCommandInvocation(command, plan.args);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(invocation.windowsVerbatimArguments
        ? { windowsVerbatimArguments: true }
        : {})
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      handlers.stdout?.(chunk.toString());
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      handlers.stderr?.(chunk.toString());
    });
    child.once('error', (error) => {
      reject(error);
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat([...stderr, ...stdout]).toString().trim();
      reject(new Error(detail || `${plan.command} exited with code ${code ?? 'unknown'}`));
    });
    child.stdin.end(plan.stdin);
  });
}
