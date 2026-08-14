import * as path from 'node:path';
import { readdir, stat } from 'node:fs/promises';

export interface UploadPlanFile {
  /** 本地绝对路径 */
  local: string;
  /** 远程 POSIX 路径（含目标根） */
  remote: string;
}

export interface UploadPlan {
  files: UploadPlanFile[];
  /** 需要创建的远程目录（含目标根自身与空目录） */
  dirs: string[];
  totalBytes: number;
}

/**
 * 递归规划上传清单与总大小。
 *
 * 每个源（文件或目录）都挂在 `targetDir/<basename>` 下：
 * - 文件源 → remote = `targetDir/xx.exe`；
 * - 目录源 VPN → 目录名进入路径（remote = `targetDir/VPN/xx.exe`），
 *   目录（含空目录）记入 dirs，上传阶段统一创建。
 *
 * 修复历史缺陷：旧实现目录源从 targetDir 开始导致目录名丢失，且文件分支
 * 重复拼接 basename 造成 `xx.exe/xx.exe`（文件被当成目录）。
 */
export async function planUploads(
  sources: string[], targetDir: string
): Promise<UploadPlan> {
  const files: UploadPlanFile[] = [];
  const dirs = new Set<string>([targetDir]);
  let totalBytes = 0;

  const walk = async (localPath: string, remoteDir: string): Promise<void> => {
    dirs.add(remoteDir);
    const entries = await readdir(localPath, { withFileTypes: true });
    for (const child of entries) {
      const childLocal = path.join(localPath, child.name);
      const childRemote = path.posix.join(remoteDir, child.name);
      if (child.isDirectory()) {
        await walk(childLocal, childRemote);
      } else if (child.isFile()) {
        const entry = await stat(childLocal);
        files.push({ local: childLocal, remote: childRemote });
        totalBytes += entry.size;
      }
    }
  };

  for (const source of sources) {
    const entry = await stat(source);
    const remoteRoot = path.posix.join(targetDir, path.basename(source));
    if (entry.isDirectory()) {
      await walk(source, remoteRoot);
    } else {
      files.push({ local: source, remote: remoteRoot });
      totalBytes += entry.size;
    }
  }

  return { files, dirs: [...dirs], totalBytes };
}
