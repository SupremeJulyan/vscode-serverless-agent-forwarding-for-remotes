import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import type { CapturedProcessResult } from './process';

/**
 * Agent CLI 的 MCP server 注册抽象与内置实现。
 *
 * 每个 Agent 定义包含一套 mcp 能力：
 *   - 默认通过 CLI 命令注册（codex/claude 风格：`<cli> mcp add/get/remove ...`）
 *   - 没有 mcp 子命令的 Agent（如 pi）提供 handler 实现，直接读写其配置文件
 *
 * 新增 Agent 只需在 builtinAgentDefinitions 中追加一条定义，
 * 未知 CLI 名会自动回退到 codex 风格参数（genericAgentDefinition）。
 */

// ─── 抽象类型 ─────────────────────────────────────────────────────────────────

/** 不走 CLI 的 MCP 注册实现（返回与 executeCaptured 一致的形状） */
export interface AgentMcpHandler {
  /** 探测时直接使用，无需依赖 CLI 输出 */
  supportsMcp: boolean;
  get(serverName: string): Promise<CapturedProcessResult>;
  add(serverName: string, url: string): Promise<CapturedProcessResult>;
  remove(serverName: string): Promise<CapturedProcessResult>;
  /** “复制手工配置命令”时的展示文本 */
  describeAdd(serverName: string, url: string): string;
  /** 可选：前置条件缺失时返回提示文本（如 pi 需要已安装 pi-mcp-extension） */
  prerequisiteCheck?(): Promise<string | undefined>;
}

export interface AgentMcpCapability {
  get: (serverName: string) => string[];
  add: (serverName: string, url: string) => string[];
  remove: (serverName: string) => string[];
  /** 可选：内置处理器，不走 CLI 命令（如 pi 通过配置文件注册 MCP） */
  handler?: AgentMcpHandler;
}

export interface AgentDefinition {
  /** 配置 key，即 Agent CLI 命令名（如 codex、claude、pi） */
  cliName: string;
  /** 旧版配置兼容 key（如 claudeCode） */
  legacyIds?: string[];
  /** 用户可读显示名 */
  displayName: string;
  /** 对应 VS Code Agent 扩展 ID，用于查找内置 CLI */
  extensionId?: string;
  /** 扩展安装路径 → 内置 CLI 候选列表 */
  bundledCandidates?: (extensionPath: string) => Promise<string[]>;
  /** MCP server 注册命令参数模板 */
  mcp: AgentMcpCapability;
}

/** 注册表向调用方提供的 CLI 执行能力（由宿主注入，避免依赖 vscode/日志实现） */
export interface AgentMcpCliRunner {
  /** 执行一条 CLI 命令并返回结果 */
  run(command: string, args: string[]): Promise<CapturedProcessResult>;
  /** 记录 handler 操作的日志行 */
  log(message: string): void;
}

// ─── pi 的具体实现（无 mcp 子命令，通过 pi-mcp-extension 的配置文件注册） ──────

/**
 * pi（pi-coding-agent）没有内置 mcp 子命令；MCP server 通过
 * pi-mcp-extension 的配置文件 ~/.pi/agent/mcp.json 注册。
 * 这里把 SAFS 的固定 HTTP MCP 路由写入该配置文件。
 */

export interface PiMcpConfigFile {
  settings?: Record<string, unknown>;
  mcpServers?: Record<string, Record<string, unknown>>;
}

export function piMcpConfigPath(baseDir = os.homedir()): string {
  return path.join(baseDir, '.pi', 'agent', 'mcp.json');
}

function piMcpSettingsPath(baseDir = os.homedir()): string {
  return path.join(baseDir, '.pi', 'agent', 'settings.json');
}

function piMcpResult(exitCode: number, stdout = '', stderr = ''): CapturedProcessResult {
  return { exitCode, stdout, stderr, truncated: false };
}

export async function readPiMcpConfig(configPath: string): Promise<PiMcpConfigFile> {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as PiMcpConfigFile;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Missing or invalid file: treat as empty config.
  }
  return {};
}

/**
 * 判断 pi 是否安装了 pi-mcp-extension。
 * VS Code 集成的 pi 通过 PI_CODING_AGENT_DIR 把 agentDir 指向 bundled-pi-agent，
 * 独立终端里的 pi 用 ~/.pi/agent —— 两处 settings.json 都检查。
 */
export async function piMcpExtensionInstalled(
  baseDir = os.homedir(), envAgentDir = process.env.PI_CODING_AGENT_DIR
): Promise<boolean> {
  const candidates = [piMcpSettingsPath(baseDir)];
  if (envAgentDir) {
    candidates.push(path.join(envAgentDir, 'settings.json'));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(
        await readFile(candidate, 'utf8')
      ) as { packages?: unknown };
      const packages = Array.isArray(parsed.packages)
        ? parsed.packages.map((item) => String(item))
        : [];
      if (packages.some((item) => item.includes('pi-mcp-extension'))) return true;
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

export function piAgentMcpHandler(options?: { baseDir?: string }): AgentMcpHandler {
  const configPath = piMcpConfigPath(options?.baseDir);
  const mutate = async (
    mutateFn: (config: PiMcpConfigFile) => void,
    okMessage: string
  ): Promise<CapturedProcessResult> => {
    try {
      const config = await readPiMcpConfig(configPath);
      mutateFn(config);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      return piMcpResult(0, okMessage);
    } catch (error) {
      return piMcpResult(
        1, '', `pi-mcp config update failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };
  return {
    supportsMcp: true,
    get: async (serverName) => {
      const server = (await readPiMcpConfig(configPath)).mcpServers?.[serverName];
      if (!server) {
        return piMcpResult(0, `pi-mcp: server "${serverName}" not configured`);
      }
      return piMcpResult(0, JSON.stringify({ serverName, ...server }, null, 2));
    },
    add: (serverName, url) => mutate((config) => {
      config.mcpServers ??= {};
      config.mcpServers[serverName] = {
        transport: 'streamable-http',
        url,
        lifecycle: 'eager'
      };
    }, `pi-mcp: server "${serverName}" registered (streamable-http)`),
    remove: (serverName) => mutate((config) => {
      delete config.mcpServers?.[serverName];
    }, `pi-mcp: server "${serverName}" removed`),
    describeAdd: (serverName, url) => (
      `编辑 ~/.pi/agent/mcp.json（需已安装 pi-mcp-extension：pi install npm:pi-mcp-extension）：\n`
      + JSON.stringify({
        mcpServers: {
          [serverName]: { transport: 'streamable-http', url, lifecycle: 'eager' }
        }
      }, null, 2)
    ),
    prerequisiteCheck: async () => {
      if (await piMcpExtensionInstalled(options?.baseDir)) return undefined;
      return '未安装 pi-mcp-extension（在 pi 中执行 pi install npm:pi-mcp-extension），MCP 配置写入后 pi 不会自动连接。';
    }
  };
}

// ─── 内置 Agent 定义 ──────────────────────────────────────────────────────────

export const builtinAgentDefinitions: AgentDefinition[] = [
  {
    cliName: 'codex',
    displayName: 'Codex',
    extensionId: 'openai.chatgpt',
    bundledCandidates: async (extensionPath) => {
      const binRoot = path.join(extensionPath, 'bin');
      try {
        const platformDirectories = await readdir(binRoot, { withFileTypes: true });
        return platformDirectories
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(
            binRoot, entry.name, process.platform === 'win32' ? 'codex.exe' : 'codex'
          ));
      } catch {
        // The installed Codex extension does not expose a bundled CLI.
        return [];
      }
    },
    mcp: {
      get: (serverName) => ['mcp', 'get', serverName],
      add: (serverName, url) => ['mcp', 'add', serverName, '--url', url],
      remove: (serverName) => ['mcp', 'remove', serverName]
    }
  },
  {
    cliName: 'claude',
    legacyIds: ['claudeCode'],
    displayName: 'Claude Code',
    extensionId: 'anthropic.claude-code',
    bundledCandidates: async (extensionPath) => [
      path.join(
        extensionPath, 'resources', 'native-binary',
        process.platform === 'win32' ? 'claude.exe' : 'claude'
      )
    ],
    mcp: {
      get: (serverName) => ['mcp', 'get', serverName],
      add: (serverName, url) => [
        'mcp', 'add', '--transport', 'http', '--scope', 'user', serverName, url
      ],
      remove: (serverName) => ['mcp', 'remove', serverName]
    }
  },
  {
    cliName: 'pi',
    displayName: 'Pi (pi-coding-agent)',
    mcp: {
      get: (serverName) => ['mcp', 'get', serverName],
      add: (serverName, url) => ['mcp', 'add', serverName, '--url', url],
      remove: (serverName) => ['mcp', 'remove', serverName],
      // pi 没有 mcp 子命令：通过 pi-mcp-extension 的配置文件注册
      handler: piAgentMcpHandler()
    }
  }
];

/** 未知 CLI 的通用定义：按 codex 风格参数尝试 MCP 注册 */
export function genericAgentDefinition(cliName: string): AgentDefinition {
  return {
    cliName,
    displayName: cliName,
    mcp: {
      get: (serverName) => ['mcp', 'get', serverName],
      add: (serverName, url) => ['mcp', 'add', serverName, '--url', url],
      remove: (serverName) => ['mcp', 'remove', serverName]
    }
  };
}

/** 把配置里的 CLI 名解析为 Agent 定义（兼容旧 key、去重） */
export function resolveAgentDefinitions(cliNames: string[]): AgentDefinition[] {
  const result: AgentDefinition[] = [];
  const seen = new Set<string>();
  for (const name of cliNames) {
    const builtin = builtinAgentDefinitions.find(
      (def) => def.cliName === name || def.legacyIds?.includes(name)
    );
    const def = builtin ?? genericAgentDefinition(name);
    if (seen.has(def.cliName)) continue;
    seen.add(def.cliName);
    result.push(def);
  }
  return result;
}

// ─── 探测与操作分发 ───────────────────────────────────────────────────────────

/** CLI 报错匹配这些模式时判定为不支持 'mcp' 子命令 */
export const mcpUnsupportedPattern = /unknown command|unrecognized|no such command|invalid command|command not found|not a valid command/i;

export function agentSupportsMcp(probe: CapturedProcessResult): boolean {
  if (probe.exitCode === 0) return true;
  return !mcpUnsupportedPattern.test(`${probe.stdout}\n${probe.stderr}`);
}

/** 探测结果 → 该 Agent 是否支持 MCP（handler 定义的 Agent 直接视为支持） */
export function agentSupportsMcpFor(
  def: AgentDefinition, probe: CapturedProcessResult
): boolean {
  return def.mcp.handler ? def.mcp.handler.supportsMcp : agentSupportsMcp(probe);
}

/**
 * 执行一次 MCP 注册操作：优先使用内置 handler，否则回退到 CLI 命令。
 * 返回与 executeCaptured 一致的形状，调用方只关心 exitCode/stdout/stderr。
 */
export async function runAgentMcpOperation(
  def: AgentDefinition,
  op: 'get' | 'add' | 'remove',
  url: string | undefined,
  runner: AgentMcpCliRunner,
  serverName = 'safs'
): Promise<CapturedProcessResult> {
  const handler = def.mcp.handler;
  if (handler) {
    const result = op === 'get'
      ? await handler.get(serverName)
      : op === 'add'
        ? await handler.add(serverName, url!)
        : await handler.remove(serverName);
    runner.log(`pi-mcp:${op} ${serverName} → exit ${result.exitCode}`);
    return result;
  }
  const args = op === 'get'
    ? def.mcp.get(serverName)
    : op === 'add'
      ? def.mcp.add(serverName, url!)
      : def.mcp.remove(serverName);
  return runner.run(def.cliName, args);
}
