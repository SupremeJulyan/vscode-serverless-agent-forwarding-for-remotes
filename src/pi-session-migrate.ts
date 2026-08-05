import * as os from 'node:os';
import * as path from 'node:path';
import { readdir, rename, stat } from 'node:fs/promises';
import { MountConfig } from './config';

/**
 * Pi/vscode-pi keys its conversation history by the agent cwd placeholder
 * path (sanitized), e.g.:
 *
 *   --c--Users-julyan-AppData-Roaming-Code-User-globalStorage-julyan.safs-
 *   serverless-agent-forwarding-agent-cwd-<hash>-<mount>--
 *
 * The <hash>-<mount> core is stable across platforms, but the prefix changes
 * when the user switches between WSL and native Windows, or when the
 * extension/globalStorage folder is renamed — so old conversations look
 * "lost". This helper merges session files from legacy SAFS keys of the same
 * mount into the most recently used key directory. It only moves .jsonl
 * files (never deletes anything) and skips name collisions.
 */
const sessionCorePattern = /agent-cwd-[0-9a-f]{16}-([^-]+)--$/;

export async function migratePiSessionKeys(
  mounts: MountConfig[],
  log: (message: string) => void = () => undefined
): Promise<string[]> {
  const sessionsRoot = path.join(os.homedir(), '.pi', 'agent', 'sessions');
  let names: string[];
  try {
    names = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return []; // no pi data dir
  }

  // Group session key directories by their mount name core.
  const byMount = new Map<string, string[]>();
  for (const name of names) {
    const match = sessionCorePattern.exec(name);
    if (match) {
      const mountName = match[1];
      byMount.set(mountName, [...(byMount.get(mountName) ?? []), name]);
    }
  }

  const configured = new Set(mounts.map((mount) => mount.name));
  const migrated: string[] = [];
  for (const [mountName, keys] of byMount) {
    if (!configured.has(mountName) || keys.length < 2) continue;

    // Pick the most recently used key directory as the target.
    let target = keys[0];
    let targetMtime = await dirMtime(path.join(sessionsRoot, keys[0]));
    for (const key of keys.slice(1)) {
      const mtime = await dirMtime(path.join(sessionsRoot, key));
      if (mtime > targetMtime) {
        target = key;
        targetMtime = mtime;
      }
    }

    for (const key of keys) {
      if (key === target) continue;
      const sourceDir = path.join(sessionsRoot, key);
      const targetDir = path.join(sessionsRoot, target);
      try {
        const files = (await readdir(sourceDir)).filter((name) => name.endsWith('.jsonl'));
        let moved = 0;
        for (const file of files) {
          const destination = path.join(targetDir, file);
          try {
            await stat(destination);
          } catch {
            await rename(path.join(sourceDir, file), destination);
            moved++;
          }
        }
        if (moved > 0) {
          migrated.push(`${mountName}: ${key} -> ${target} (${moved} 个会话)`);
          log(`[会话迁移] ${mountName}: ${key} -> ${target} (${moved} 个会话)`);
        }
      } catch {
        // Never fail activation because of a migration hiccup.
      }
    }
  }
  return migrated;
}

async function dirMtime(directory: string): Promise<number> {
  try {
    const info = await stat(directory);
    return info.mtimeMs;
  } catch {
    return 0;
  }
}
