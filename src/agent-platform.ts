import * as os from 'node:os';
import { executeCaptured } from './process';

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

/** 解析 `safs.agentPlatform` 设置为平台上下文；WSL home 检测失败时回退到插件家目录。 */
export async function resolveAgentPlatform(value: unknown): Promise<AgentPlatformContext> {
  const kind = resolveAgentPlatformSetting(value);
  if (kind === 'wsl') {
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
