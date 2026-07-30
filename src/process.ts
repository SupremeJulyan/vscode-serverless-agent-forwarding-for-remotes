import { execFile, spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { CommandPlan } from './platform';

const execFileAsync = promisify(execFile);

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

async function resolveExecutable(command: string, env?: NodeJS.ProcessEnv): Promise<string> {
  if (process.platform === 'win32' || command.includes('/')) return command;
  const cacheKey = JSON.stringify({ command, path: env?.PATH });
  const cached = resolvedCache.get(cacheKey);
  if (cached !== undefined) return cached;
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

export async function isMountpoint(target: string): Promise<boolean> {
  try {
    await execFileAsync('mountpoint', ['-q', '--', target]);
    return true;
  } catch {
    return false;
  }
}

export async function commandSucceeds(plan: CommandPlan): Promise<boolean> {
  try {
    await execFileAsync(plan.command, plan.args, {
      cwd: plan.cwd, env: { ...process.env, ...plan.env }
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
  plan: CommandPlan, signal?: AbortSignal, maxOutputBytes = 1024 * 1024
): Promise<CapturedProcessResult> {
  const command = await resolveExecutable(plan.command, plan.env);
  return new Promise<CapturedProcessResult>((resolve, reject) => {
    const child = spawn(command, plan.args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
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
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
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
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, plan.args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
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
