import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { CommandPlan } from './platform';

const execFileAsync = promisify(execFile);

export async function commandExists(command: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('where.exe', [command], { windowsHide: true });
    } else {
      await execFileAsync('sh', ['-lc', `command -v "$1" >/dev/null 2>&1`, 'sh', command]);
    }
    return true;
  } catch {
    return false;
  }
}

export async function isMountpoint(target: string): Promise<boolean> {
  try {
    await execFileAsync('mountpoint', ['-q', '--', target], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export async function commandSucceeds(plan: CommandPlan, timeoutMs = 3000): Promise<boolean> {
  try {
    await execFileAsync(plan.command, plan.args, {
      cwd: plan.cwd, env: { ...process.env, ...plan.env }, timeout: timeoutMs
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

async function resolveExecutable(command: string, env?: NodeJS.ProcessEnv): Promise<string> {
  if (process.platform === 'win32' || command.includes('/')) return command;
  try {
    const { stdout } = await execFileAsync(
      'sh', ['-lc', 'command -v "$1"', 'sh', command],
      { env: { ...process.env, ...env } }
    );
    const resolved = stdout.trim().split(/\r?\n/, 1)[0];
    return resolved.startsWith('/') ? resolved : command;
  } catch {
    return command;
  }
}

export async function executeWithStdin(
  plan: CommandPlan, handlers: ProcessOutputHandlers = {}, timeoutMs?: number
): Promise<void> {
  // VS Code's extension host can have an older PATH than its login shell.
  // Resolve bridge tools through that shell before spawning them directly.
  const command = await resolveExecutable(plan.command, plan.env);
  await new Promise<void>((resolve, reject) => {
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const child = spawn(command, plan.args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // Fall back to terminating the direct child below.
          child.kill();
        }
        // Some sshfs/FUSE processes do not exit on SIGTERM. Without escalation,
        // the promise keeps waiting for "close" forever after the timeout fires.
        forceKillTimer = setTimeout(() => {
          if (child.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL');
              return;
            } catch {
              // Fall back to terminating the direct child below.
            }
          }
          child.kill('SIGKILL');
        }, 250);
        return;
      }
      child.kill();
    }, timeoutMs);
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
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (timedOut) {
        reject(new Error(
          `Timed out after ${Math.ceil((timeoutMs ?? 0) / 1000)} seconds: ` +
          `${plan.command} ${plan.args.join(' ')}`
        ));
        return;
      }
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

export async function waitForMount(target: string, timeoutSeconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (await isMountpoint(target)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
