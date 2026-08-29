import * as path from 'node:path';
import { SftpSession } from './sftp/session';
import { assertSafeRemoteEntryName } from './sftp/uri';

/**
 * 远程同步的指纹引擎（纯函数，无 vscode 依赖，可单测）。
 *
 * 指纹行格式：`f:<rel>:<size>:<mtime>`（文件）或 `d:<rel>:<mtime>`（目录），
 * rel 为相对任务根（remotePath）的 POSIX 路径。diff 用 size+mtime（SFTP
 * 秒级粒度）识别变化，并在条目类型互换（file↔dir）时同时给出 remove 与
 * create，由调用方"先删后建"，避免 mkdir/writeFile 撞上类型冲突。
 */

/** 递归扫描远程子树，返回排序后的指纹行数组。 */
export async function scanRemote(
  session: SftpSession, remotePath: string, signal?: AbortSignal
): Promise<string[]> {
  const rootStat = await session.stat(remotePath, signal);
  if (rootStat.type !== 'directory') {
    return [`f::${rootStat.size}:${rootStat.mtime}`];
  }
  const lines: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await session.readDirectory(dir, signal);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      assertSafeRemoteEntryName(entry.name);
      // The sync protocol does not preserve links. Treating one as a regular
      // file would make readFile follow it outside the selected remote root.
      if (entry.type === 'symbolic-link') continue;
      const full = path.posix.join(dir, entry.name);
      const rel = path.posix.relative(remotePath, full);
      if (entry.type === 'directory') {
        lines.push(`d:${rel}:${entry.mtime}`);
        await walk(full);
      } else {
        lines.push(`f:${rel}:${entry.size}:${entry.mtime}`);
      }
    }
  };
  await walk(remotePath);
  return lines;
}

export function linesToMap(lines: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lines) {
    const rel = line.slice(2, line.indexOf(':', 2));
    map.set(rel, line);
  }
  return map;
}

export interface FingerprintDiff {
  changed: boolean;
  /** 需要删除的本地路径（相对任务根）。类型互换的条目也在此列（先删后建）。 */
  remove: string[];
  /** 需要创建/更新的条目：rel → 指纹行（首字符 f/d 表示类型）。 */
  create: Map<string, string>;
}

/** 增量 diff：新增/内容变化/类型互换 → create；本地残留/类型互换 → remove。 */
export function diffFingerprints(
  current: Map<string, string>, previous: Map<string, string>
): FingerprintDiff {
  const remove: string[] = [];
  const create = new Map<string, string>();
  for (const [rel, line] of current) {
    const old = previous.get(rel);
    if (old === line) continue;
    create.set(rel, line);
    // 同一 rel 类型互换（f↔d）：必须先在本地删除旧类型，再创建新类型。
    if (old && old[0] !== line[0]) remove.push(rel);
  }
  for (const rel of previous.keys()) {
    if (!current.has(rel)) remove.push(rel);
  }
  return { changed: create.size > 0 || remove.length > 0, remove, create };
}
