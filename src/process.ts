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

export async function commandSucceeds(plan: CommandPlan): Promise<boolean> {
  try {
    await execFileAsync(plan.command, plan.args, {
      cwd: plan.cwd, env: { ...process.env, ...plan.env }, timeout: 3000
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

export async function executeWithStdin(
  plan: CommandPlan, handlers: ProcessOutputHandlers = {}
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
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
    child.once('error', reject);
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
