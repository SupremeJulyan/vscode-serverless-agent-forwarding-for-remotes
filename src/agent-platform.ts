import * as os from 'node:os';
import { executeCaptured } from './process';

/**
 * Agent 工作位置的解析：默认（auto）与插件运行平台相同；`wsl` 表示 Agent
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

/**
 * 构造"激活用户交互环境"的 wsl 命令：预设非空 PS1 绕过 .bashrc 的
 * `[ -z "$PS1" ] && return` 守卫后加载 .profile/.bashrc——nvm 等只在交互
 * shell 生效的 PATH 配置（如 codex 装在 nvm 的 node 版本 bin 目录）才能
 * 被检测/执行。脚本以 $1..$n 接收位置参数。
 */
export function wslBashInvocation(
  script: string, args: string[]
): { command: string; args: string[] } {
  return {
    command: 'wsl.exe',
    args: [
      '-e', 'bash', '-c',
      'export PS1="safs $ "; [ -f "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1;'
        + ' [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1; ' + script,
      'safs', ...args
    ]
  };
}

/** 在 WSL 内（激活用户交互环境）检测 CLI 是否存在于 PATH（`command -v`）。 */
export async function wslCommandExists(command: string): Promise<boolean> {
  try {
    const result = await executeCaptured(
      wslBashInvocation('command -v -- "$1" >/dev/null 2>&1', [command]),
      undefined, 16 * 1024
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
