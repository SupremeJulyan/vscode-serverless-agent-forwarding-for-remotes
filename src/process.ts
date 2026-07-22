import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CommandPlan } from './platform';

const execFileAsync = promisify(execFile);

export async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('sh', ['-lc', `command -v "$1" >/dev/null 2>&1`, 'sh', command]);
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
