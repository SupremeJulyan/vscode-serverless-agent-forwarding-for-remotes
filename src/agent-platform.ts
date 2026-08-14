import * as os from 'node:os';
import * as path from 'node:path';
import { access, readdir } from 'node:fs/promises';
import { executeCaptured } from './process';
import { detectPlatform } from './platform';
import type { AgentDefinition } from './agent-mcp-registry';

/**
 * Agent 所在平台的解析：默认（auto）与插件运行平台相同；`wsl` 表示 Agent
 * 在 WSL 中运行——MCP 注册读写 WSL 的家目录（如 `~/.pi/agent/mcp.json`、
 * `$DSH_HOME/cordis.patch.yml`），Agent CLI 也通过 `wsl.exe` 在 WSL 内执行。
 */

export type AgentPlatformKind = 'auto' | 'wsl';

export interface AgentPlatformContext {
  /** 设置值：auto（与插件同平台）或 wsl */
  kind: AgentPlatformKind;
  /** Agent 的家目录（Windows 可访问路径；WSL 场景为 UNC，如 \\wsl$\Ubuntu\home\user） */
  home: string;
  /** 是否在 WSL 内执行 Agent CLI（插件进程在 Windows，Agent 在 WSL） */
  wsl: boolean;
}

export function resolveAgentPlatformSetting(value: unknown): AgentPlatformKind {
  return value === 'wsl' ? 'wsl' : 'auto';
}

/**
 * 解析 WSL 家目录为 Windows 可访问路径（UNC）。
 * 通过 `wsl.exe -e sh -lc 'wslpath -w "$HOME"'` 获取；wsl.exe 不可用或
 * 无默认发行版时返回 undefined。
 */
export async function wslHomeDirectory(): Promise<string | undefined> {
  try {
    const result = await executeCaptured(
      { command: 'wsl.exe', args: ['-e', 'sh', '-lc', 'wslpath -w "$HOME"'] },
      undefined, 64 * 1024
    );
    const home = result.stdout.trim();
    if (result.exitCode === 0 && home) return home;
  } catch {
    // wsl.exe unavailable.
  }
  return undefined;
}

/**
 * 解析 `safs.agentPlatform` 设置为平台上下文。
 *
 * 插件本身在 WSL 中运行时（VS Code WSL 窗口），Agent 与插件同处 WSL：
 * 家目录就是 `os.homedir()`（如 `/home/user`），且 WSL 的 Linux 文件系统
 * 无法访问 `wsl.exe` 返回的 Windows UNC 路径，因此无论设置值如何都直接
 * 使用本地家目录，不做 `wsl.exe` 间接解析。
 *
 * 仅当插件在 Windows 上运行且设置为 `wsl` 时，才通过 `wsl.exe` 解析 WSL
 * 家目录（UNC）；解析失败时回退到插件家目录。
 *
 * @param value - `safs.agentPlatform` 设置值。
 * @param extensionPlatform - 插件运行平台（默认按当前进程检测；测试可注入）。
 */
export async function resolveAgentPlatform(
  value: unknown,
  extensionPlatform = detectPlatform()
): Promise<AgentPlatformContext> {
  const kind = resolveAgentPlatformSetting(value);
  const extensionInWsl = extensionPlatform === 'wsl';
  if (kind === 'wsl' && !extensionInWsl) {
    return {
      kind,
      home: await wslHomeDirectory() ?? os.homedir(),
      wsl: true
    };
  }
  return { kind, home: os.homedir(), wsl: false };
}

/** 在 WSL 内检测 CLI 是否存在于 PATH（`command -v`）。 */
export async function wslCommandExists(command: string): Promise<boolean> {
  try {
    const result = await executeCaptured(
      { command: 'wsl.exe', args: ['-e', 'sh', '-lc', `command -v '${command}' >/dev/null 2>&1`] },
      undefined, 16 * 1024
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** 通过 `wslpath -u` 把 Windows/UNC 路径转换为 WSL 内的 Linux 路径；失败返回 undefined。 */
export async function wslLinuxPath(windowsPath: string): Promise<string | undefined> {
  try {
    const result = await executeCaptured(
      { command: 'wsl.exe', args: ['-e', 'wslpath', '-u', windowsPath] },
      undefined, 16 * 1024
    );
    const converted = result.stdout.trim();
    if (result.exitCode === 0 && converted) return converted;
  } catch {
    // wsl.exe unavailable.
  }
  return undefined;
}

/**
 * 统一的扩展内置 CLI 候选筛选：构造候选列表并逐个验证存在性。
 * 两个平台分支共用（`detectAgentCommand` 的本地与 WSL 路径），平台只决定
 * 扩展目录来源与二进制名（`bundledCandidates` 的 platform 参数）。
 */
export async function bundledCliCandidate(
  def: AgentDefinition,
  extensionPath: string,
  platform?: NodeJS.Platform
): Promise<string | undefined> {
  if (!def.extensionId || !def.bundledCandidates) return undefined;
  for (const candidate of await def.bundledCandidates(extensionPath, platform)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/**
 * 在 WSL 的 VS Code Server 扩展目录（`~/.vscode-server/extensions/<extId>-*`）
 * 中查找 Agent 的内置 CLI（如 `openai.chatgpt-*-linux-x64/bin/linux-x86_64/codex`）。
 *
 * 场景：插件运行在 Windows（`agentPlatform=wsl`），Agent 在 WSL 中，而
 * `vscode.extensions.getExtension` 只能看到 Windows 端的扩展——WSL 里
 * VS Code Server 安装的扩展只能通过 UNC 路径直接扫描。
 * 返回 WSL 内的 Linux 路径（供 `wsl.exe -e <cli> ...` 执行），转换失败时
 * 回退到 Windows 可访问路径。
 */
export async function wslBundledCli(
  def: AgentDefinition, wslHome: string
): Promise<string | undefined> {
  if (!def.extensionId || !def.bundledCandidates) return undefined;
  const extensionsRoot = path.join(wslHome, '.vscode-server', 'extensions');
  let entries: string[];
  try {
    entries = await readdir(extensionsRoot);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${def.extensionId}-`)) continue;
    const candidate = await bundledCliCandidate(
      def, path.join(extensionsRoot, entry), 'linux'
    );
    if (candidate) return await wslLinuxPath(candidate) ?? candidate;
  }
  return undefined;
}
