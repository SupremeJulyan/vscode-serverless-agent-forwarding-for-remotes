import * as path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

export function isLocalPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

/** Translate a WSL Agent path into the native Windows extension-host view. */
export function localPathFromAgent(
  value: string, agentPlatform?: string, hostPlatform: NodeJS.Platform = process.platform
): string {
  if (hostPlatform !== 'win32' || agentPlatform !== 'wsl') return value;
  const match = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(value.trim());
  if (!match) return value;
  const rest = (match[2] ?? '').replace(/\//g, '\\');
  return `${match[1].toUpperCase()}:\\${rest}`;
}

/** Translate a native Windows staging path into the view seen by a WSL Agent. */
export function localPathForAgent(
  value: string, agentPlatform?: string, hostPlatform: NodeJS.Platform = process.platform
): string {
  if (hostPlatform !== 'win32' || agentPlatform !== 'wsl') return value;
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(value.trim());
  if (!match) return value;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

async function assertNoLinkedTargetComponent(root: string, target: string): Promise<void> {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  let current = path.resolve(root);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`本地下载目标包含符号链接：${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A missing component means every remaining descendant is also absent.
      return;
    }
  }
}

/** Existing upload sources must resolve inside the automatically selected local staging root. */
export async function validateLocalUploadSource(root: string, source: string): Promise<string> {
  if (!path.isAbsolute(source)) throw new Error('本地上传源必须是绝对路径');
  const realRoot = await realpath(root);
  const realSource = await realpath(source);
  if (!isLocalPathInside(realRoot, realSource)) {
    throw new Error(`本地上传源超出 Agent 工作目录：${source}`);
  }
  return path.resolve(source);
}

/** Download targets must be lexical descendants of root and contain no linked component. */
export async function validateLocalDownloadTarget(root: string, target: string): Promise<string> {
  if (!path.isAbsolute(target)) throw new Error('本地下载目标必须是绝对路径');
  await realpath(root);
  const lexicalRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isLocalPathInside(lexicalRoot, resolvedTarget)) {
    throw new Error(`本地下载目标超出 Agent 工作目录：${target}`);
  }
  await assertNoLinkedTargetComponent(lexicalRoot, resolvedTarget);
  return resolvedTarget;
}
