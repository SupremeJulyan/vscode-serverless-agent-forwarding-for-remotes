import * as path from 'node:path';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { executeCaptured } from './process';

/**
 * WSL 家目录（`\\wsl.localhost\<发行版>\<路径>`）下的文件读写桥。
 *
 * 扩展宿主（VS Code 内置 Node 20.x）对 UNC 路径有主机白名单检查，直接
 * `fs` 读写 `\\wsl.localhost\...` 会抛 `UNC host 'wsl.localhost' access is
 * not allowed`（Node 24 无此限制）。这里把这类路径的操作转到
 * `wsl.exe -d <发行版>` 内在 Linux 侧完成，任何环境都稳定。
 */

export interface WslUncPath {
  distro: string;
  linuxPath: string;
}

/** 解析 `\\wsl.localhost\<distro>\<rest>` → 发行版 + Linux 路径（如 /home/user）。 */
export function parseWslUncPath(value: string): WslUncPath | undefined {
  const match = /^\\\\wsl\.localhost\\([^\\]+)\\(.*)$/i.exec(value.trim());
  if (!match) return undefined;
  return { distro: match[1], linuxPath: `/${match[2].replace(/\\/g, '/')}` };
}

/** 在发行版内执行一段 `sh -lc` 脚本；位置参数依次为 $1、$2…（$0 固定为 safs）。 */
async function wslExec(distro: string, script: string, args: string[]): Promise<string> {
  const result = await executeCaptured(
    { command: 'wsl.exe', args: ['-d', distro, '-e', 'sh', '-lc', script, 'safs', ...args] },
    undefined, 64 * 1024
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout;
    const error = new Error(`wsl 命令失败（exit ${result.exitCode}）：${detail}`) as Error & {
      code?: string;
    };
    // 让调用方的 ENOENT 分支（如“文件不存在时返回空”）在两种路径下行为一致。
    if (/no such file|not found/i.test(result.stderr)) error.code = 'ENOENT';
    throw error;
  }
  return result.stdout;
}

/** 读取文本文件：WSL UNC 路径走 wsl.exe `cat`，其它走 fs。 */
export async function readTextFile(filePath: string): Promise<string> {
  const wsl = parseWslUncPath(filePath);
  if (wsl) return wslExec(wsl.distro, 'cat -- "$1"', [wsl.linuxPath]);
  return readFile(filePath, 'utf8');
}

/** 列出目录条目名（WSL UNC 路径走 wsl.exe `ls -1`，其它走 fs）。 */
export async function readDirectory(dirPath: string): Promise<string[]> {
  const wsl = parseWslUncPath(dirPath);
  if (wsl) {
    const out = await wslExec(wsl.distro, 'ls -1 -- "$1" 2>/dev/null || true', [wsl.linuxPath]);
    return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  return readdir(dirPath);
}

/** 检查文件/目录是否存在（WSL UNC 走 wsl.exe `test -e`；dash 内置 test 不支持 `--`）。 */
export async function pathExists(filePath: string): Promise<boolean> {
  const wsl = parseWslUncPath(filePath);
  if (wsl) {
    try {
      await wslExec(wsl.distro, 'test -e "$1"', [wsl.linuxPath]);
      return true;
    } catch {
      return false;
    }
  }
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 写文本文件。
 * - WSL UNC 路径：`mkdir -p` + 目录 chmod 700 + base64 解码写入 + 文件 chmod
 *   （mode 缺省 0600）——绕开 Node 的 UNC 白名单，且 WSL 侧权限语义正确。
 * - 其它路径：`mkdir -p` + `writeFile(..., { mode })`（行为与原先一致）。
 */
export async function writeTextFile(
  filePath: string, content: string, mode?: number
): Promise<void> {
  const wsl = parseWslUncPath(filePath);
  if (wsl) {
    const base64 = Buffer.from(content, 'utf8').toString('base64');
    const fileMode = mode ?? 0o600;
    await wslExec(
      wsl.distro,
      'mkdir -p -- "$(dirname -- "$1")" && chmod 700 -- "$(dirname -- "$1")"'
        + ` && printf %s "$2" | base64 -d > "$1" && chmod ${fileMode.toString(8)} -- "$1"`,
      [wsl.linuxPath, base64]
    );
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { encoding: 'utf8', mode });
}
