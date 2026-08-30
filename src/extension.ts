import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import * as vscode from 'vscode';
import {
  BridgeConfig, deriveMounts, ensureConfigFile, expandHome, HostConfig, loadConfig, MountConfig,
  parseSshLogin, removeMountConfig, resolveMount, saveConfig
} from './config';
import { decryptPassword, encryptPassword, isEncryptedPassword } from './password';
import {
  AskpassCredentials, createAskpassCredentials, platformUsesAskpass
} from './askpass';
import {
  CommandPlan, createPlatformAdapter, platformExtensionStateKey
} from './platform';
import {
  CapturedProcessResult, commandExists, executeCaptured,
  missingExecutableName, resolveExecutable
} from './process';
import { closeSsh2ExecSessions, executeSsh2Command, Ssh2Terminal } from './ssh2-terminal';
import {
  passwordValueOffset
} from './authentication';
import { AgentMcpServer } from './agent-mcp';import {
  AgentHttpRouter, AgentPlatformLabel, agentTaggedMcpUrl
} from './agent-http-router';
import { AgentWorkspacePublisher, discoverAgentWorkspaces } from './agent-discovery';
import {
  AgentDefinition, AgentMcpCliRunner, agentSupportsMcpFor,
  defaultForwardingAgents, handlerFallbackCommand, resolveAgentDefinitions,
  resolveUnloadAgentNames, runAgentMcpOperation
} from './agent-mcp-registry';
import {
  AgentPlatformContext, resolveAgentPlatform, wslBashInvocation, wslBundledCli, wslCommandExists
} from './agent-platform';
import {
  ensureAgentCwdPlaceholder, ensureAgentCwdSubdirectory,
  writeLastRemoteDirectory
} from './agent-cwd';
import { connectSftp } from './sftp/client';
import { SftpSession } from './sftp/session';
import { scanRemote } from './sync-diff';
import { pipeStreams, writeStreamToFile } from './stream-file';
import { planUploads } from './upload-plan';
import { defaultSshClientIdent, ensureSshCapabilities } from './ssh-algorithms';
import { SftpConnectionPool } from './sftp/connection-pool';
import { migratePiSessionKeys } from './pi-session-migrate';
import { RemoteSyncManager, RemoteSyncTask, ensureRemoteDir } from './remote-sync';
import { SyncCoordinator } from './sync-coordination';
import {
  remotePathForUri, RemoteFolder, RemoteFolderRegistry, SftpFileSystemProvider,
  workspacePathForRemote
} from './sftp/filesystem-provider';
import {
  isRemotePathInsideRoot, parseRemoteUri, remoteFileSystemScheme, remoteUri
} from './sftp/uri';
import { ensureWslBridgeExecutable, setWslBundlePath } from './wsl-bridge';
import { hostVerifierFor, setKnownHostsFilePath } from './host-key';
import {
  isOpenSshHostKeyVerificationFailure, maxOpenSshHostKeyRetries,
  runWithOpenSshHostKeyRetry, verifySystemSshHostKey
} from './system-ssh-host-key';
import {
  hasRequiredWslDependencies, installWslDependencies
} from './dependency-installer';
import { appendMcpCommandLog, appendMcpToolLog } from './mcp-log';
import { redactSensitiveText } from './redact';
import { shellQuote } from './shell-quote';
import {
  evaluateMcpCommandPolicy, readMcpCommandPolicySettings
} from './mcp-command-policy';
import {
  cleanTerminalDiagnostic, decodeTerminalDiagnostic, terminalDiagnosticPlan
} from './terminal-diagnostics';
import { shouldUseBuiltinSshTerminal } from './terminal-routing';
import {
  AgentMcpSetupResult, agentForwardingInstallMessage
} from './agent-forwarding-notification';
import {
  findRemotePathCandidates, findRemoteTerminalPaths, resolveRemoteTerminalCwdReport,
  resolveRemoteTerminalPath
} from './terminal-links';

const commandPrefix = 'safs';
const platformAdapter = createPlatformAdapter();

const platformStateKey = (name: string): string =>
  platformExtensionStateKey(name, platformAdapter.kind);
const terminalIdentityEnv = 'SERVERLESS_REMOTE_TERMINAL_ID';
const masterPasswordSecret = 'safs.masterPassword';
const agentMcpTokenSecret = platformStateKey('agentMcpToken');
const agentSetupCompletedKey = platformStateKey('agentSetupCompleted');
const aiForwardMountsKey = platformStateKey('aiForwardMounts');
const directoryHistoryKey = platformStateKey('directoryHistory');
const defaultConfigPath = '~/.safs/config.json';
const openConfigAction = 'Open Config';
const addSshConfigAction = 'Add SSH Config';
const reconnectRemoteTerminalAction = '重连终端';
const viewSafsLogAction = '查看 SAFS 日志';
const addTerminalLinkMountAction = '添加 SSH 配置';
const openTerminalLinkConfigAction = '打开配置';
const terminalCredentialTtlMs = 5 * 60 * 1000;
const logClearIntervalMs = 24 * 60 * 60 * 1000;
/** Agent MCP 探测结果缓存：configureDetectedAgents 的 get 探测在 TTL 内复用，
 * 避免每次打开目录/窗口都串行 spawn 全部 Agent CLI（codex/claude 启动可达数百 ms）。 */
const agentProbeCacheTtlMs = 60_000;
const agentProbeTimeoutMs = 15_000;
const agentProbeCache = new Map<string, { status: CapturedProcessResult; at: number }>();

let output: vscode.OutputChannel;
let bridgeOutput: vscode.LogOutputChannel | undefined;
let mcp: AgentMcpServer | undefined;
let httpRouter: AgentHttpRouter | undefined;
let httpRouterCreation: Promise<AgentHttpRouter> | undefined;
let httpRouterStart: Promise<AgentHttpRouter> | undefined;
let agentHttpRouterHeartbeat: NodeJS.Timeout | undefined;
let vscodeContext: vscode.ExtensionContext;
let pool: SftpConnectionPool;
let registry: RemoteFolderRegistry;
let provider: SftpFileSystemProvider;
const agentWorkspacePublisher = new AgentWorkspacePublisher(randomBytes(12).toString('hex'));
let agentWorkspaceHeartbeat: NodeJS.Timeout | undefined;
let lastAgentDiscoveryState = '';
let lastForwardingSignature = '';
let safsStatusBar: vscode.StatusBarItem | undefined;
let forwardingFocusStatusBar: vscode.StatusBarItem | undefined;
let syncStatusBar: vscode.StatusBarItem | undefined;
let focusedAgentSource: { name: string; platform: string } | undefined;
let refreshTree: () => void = () => undefined;
const openingTerminalIds = new Set<string>();
let lastReadConfig: BridgeConfig | undefined;
const managedRemoteTerminals = new Map<vscode.Terminal, {
  mount: MountConfig;
  remoteCwd: string;
  retryWithSystemSsh?: boolean;
  hostKeyRetries?: number;
  /** 内置 ssh2 终端实例：live-sync 用它安全补发 cd（shell 就绪前入队）。 */
  pty?: import('./ssh2-terminal').Ssh2Terminal;
  diagnostic?: { file: string; command: string };
}>();

interface SafsTerminalLink extends vscode.TerminalLink {
  mountName: string;
  rawPath: string;
  remotePath: string;
  remoteRoot: string;
  searchRoot: string;
  line?: number;
  column?: number;
}

/** 当前窗口对应挂载的活动传输通道；非远程窗口或尚未连接时返回 undefined。 */
function currentSessionTransport(): 'sftp' | 'scp' | undefined {
  // 激活早期 pool/registry 可能还未创建（状态栏先于连接池初始化）。
  if (!pool || !registry) return undefined;
  const location = currentRemoteLocation();
  const folder = location ? registry.get(location.mountName) : undefined;
  return folder ? pool.transport(folder.hostName) : undefined;
}

/** 按当前会话传输通道刷新底栏入口文案（SFTP 或 SCP 回退），不影响焦点提示。 */
function refreshSafsEntryLabel(): void {
  if (!safsStatusBar) return;
  // 服务器未提供 SFTP 子系统而回退 SCP/exec 时，入口相应显示为 SAFS SCP。
  const scpFallback = currentSessionTransport() === 'scp';
  safsStatusBar.text = scpFallback ? '$(remote) SAFS SCP' : '$(remote) SAFS SFTP';
  safsStatusBar.name = scpFallback ? 'SAFS SCP' : 'SAFS SFTP';
  safsStatusBar.tooltip = scpFallback
    ? '打开远程目录（服务器未提供 SFTP 子系统，当前经 SCP/exec 回退）'
    : '打开 SFTP 远程目录';
}

/** 同步镜像窗口：工作区是本地目录，但语义上仍绑定远程挂载并双向同步。 */
function isSyncMirrorWindow(): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.some((folder) => folder.uri.scheme === remoteFileSystemScheme)) return false;
  return folders.some(
    (folder) => folder.uri.scheme === 'file' && syncedRemoteLocation(folder.uri.fsPath)
  );
}

function updateSafsStatusBar(
  agentFocus = false, agentName?: string, agentPlatform?: string, clearSource = false
): void {
  if (!safsStatusBar || !forwardingFocusStatusBar) return;
  if (clearSource) focusedAgentSource = undefined;
  // Agent 通常在 VS Code 失焦时发起请求（用户正在操作桌面版/终端）。
  // 当下可以不显示焦点提示，但必须记住来源，以便切回窗口时恢复。
  if (agentName && agentPlatform) {
    focusedAgentSource = { name: agentName, platform: agentPlatform };
  }
  const source = focusedAgentSource
    ? `${focusedAgentSource.name}（${focusedAgentSource.platform}）`
    : 'Agent';
  // SFTP 入口与 SAFS SYNC 一样常驻；转发焦点提示单独一项，不再顶替 SFTP 文案。
  refreshSafsEntryLabel();
  // 镜像窗口在悬停里注明双向同步，避免“本地改还是远程改”的困惑。
  const mirrorHint = isSyncMirrorWindow() ? '（本地镜像：改动与远程双向同步）' : '';
  forwardingFocusStatusBar.text = focusedAgentSource
    ? `$(sparkle) ${source}远程转发中💪`
    : '$(sparkle) Agent 已聚焦当前窗口😏';
  forwardingFocusStatusBar.tooltip = focusedAgentSource
    ? `${source} 正在通过本窗口的远程连接干活${mirrorHint}`
    : `本窗口是 Agent MCP 的默认路由目标${mirrorHint}`;
  if (agentFocus) forwardingFocusStatusBar.show();
  else forwardingFocusStatusBar.hide();
}

let syncManager: RemoteSyncManager | undefined;
let syncCoordinator: SyncCoordinator | undefined;
const syncTasksKey = 'safs.syncTasks';

function saveSyncTasks(persist = true): void {
  if (!syncManager) return;
  if (persist) {
    void vscodeContext.globalState.update(
      syncTasksKey,
      syncManager.list().map(({
        mountName, remotePath, localDir, isFile, fingerprintLines, resetLocalOnFirstSync
      }) => ({
        mountName, remotePath, localDir, isFile, fingerprintLines, resetLocalOnFirstSync
      }))
    );
  }
  refreshTree();
  void updateSyncStatusBar();
}

function historySyncTask(item: HistoryItem): RemoteSyncTask | undefined {
  return syncManager?.list().find(
    (task) => task.mountName === item.mountName && task.remotePath === item.path
  );
}

/** 找到包含指定本地路径的最具体同步任务。 */
function syncTaskForLocalPath(localPath: string): RemoteSyncTask | undefined {
  const resolvedPath = path.resolve(localPath);
  return [...(syncManager?.list() ?? [])]
    .sort((left, right) => path.resolve(right.localDir).length - path.resolve(left.localDir).length)
    .find((task) => {
      const localRoot = path.resolve(task.localDir);
      const relative = path.relative(localRoot, resolvedPath);
      if (relative === '..' || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) return false;
      return !task.isFile || relative === '';
    });
}

/** 把同步镜像中的本地路径映射回远程路径。 */
function syncedRemoteLocation(localPath: string): {
  mountName: string;
  remotePath: string;
} | undefined {
  const task = syncTaskForLocalPath(localPath);
  if (!task) return undefined;
  const relative = path.relative(path.resolve(task.localDir), path.resolve(localPath));
  return {
    mountName: task.mountName,
    remotePath: relative
      ? path.posix.join(task.remotePath, relative.split(path.sep).join('/'))
      : task.remotePath
  };
}

async function updateSyncStatusBar(): Promise<void> {
  if (!syncStatusBar) return;
  const localFolders = (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => path.resolve(folder.uri.fsPath));
  let task: RemoteSyncTask | undefined;
  for (const candidate of syncManager?.list() ?? []) {
    const target = path.resolve(candidate.localDir);
    if (localFolders.some((folder) => folder === target)
      && await syncCoordinator?.isReady(
        candidate.mountName, candidate.remotePath, candidate.localDir
      )) {
      task = candidate;
      break;
    }
  }
  if (!task) {
    syncStatusBar.hide();
    return;
  }
  syncStatusBar.text = '$(sync) SAFS SYNC';
  syncStatusBar.tooltip = `正在双向同步：${task.remotePath} ↔ ${task.localDir}`;
  syncStatusBar.show();
}

// 重开远程窗口后，首次远程文件激活时无条件把自动连接的终端移到该文件目录
// （配合标签页恢复，与 safs.terminalFollowsActiveFile 无关）；后续切换文件
// 是否同步才由该设置控制。
const restoredFileSyncPending = new Set<string>();

// Channel-level failures mean the server rejects the ssh2 client's pty/shell
// negotiation (common on NSG/gateway appliances). Fall back to the system ssh
// CLI in that case; auth failures must NOT fall back (same credentials).
const builtinSshFallbackPattern = /pseudo-terminal|open shell|start subsystem|channel open/i;

class ConfigActionRequiredError extends Error {
  constructor(
    message: string,
    readonly actions = [openConfigAction],
    readonly hostName?: string
  ) {
    super(message);
  }
}

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('safs');
}

function agentTrace(stage: string, message: string): void {
  bridgeOutput?.appendLine(
    `[${new Date().toISOString()}] [Agent trace] [${stage}] ${message}`
  );
}

function logAsyncFailure(label: string, error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  bridgeOutput?.appendLine(`[${label}] ${redactSensitiveText(detail)}`);
}

function configPath(): string {
  return expandHome(defaultConfigPath);
}

/**
 * 扩展独立的 known_hosts 文件（与配置文件同目录）。
 * prompt 模式下系统 ssh 用它做 OpenSSH 原生校验兜底（见 system-ssh-host-key.ts）。
 */
function knownHostsFilePath(): string {
  return path.join(path.dirname(configPath()), 'known_hosts');
}

async function readConfig(): Promise<BridgeConfig> {
  try {
    const config = await loadConfig(configPath());
    lastReadConfig = config;
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigActionRequiredError(
        `No config file was found at ${configPath()}.`,
        [addSshConfigAction]
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigActionRequiredError(`Cannot read ${configPath()}: ${message}`);
  }
}

function planDisplayName(plan: CommandPlan): string {
  const args = plan.args.map((argument, index) => {
    const previous = plan.args[index - 1]?.toLowerCase();
    return previous === '-command' && argument.includes('\n') ? '<script>' : argument;
  });
  return [plan.command, ...args].join(' ');
}

function redactAgentMcpText(value: string): string {
  return redactSensitiveText(value);
}

async function executeAgentMcpCommand(
  plan: CommandPlan, signal?: AbortSignal, maxOutputBytes = 1024 * 1024
): Promise<Awaited<ReturnType<typeof executeCaptured>>> {
  const displayName = redactAgentMcpText(planDisplayName(plan));
  bridgeOutput?.appendLine(`[${new Date().toLocaleString()}] [Agent MCP] $ ${displayName}`);
  try {
    const result = await executeCaptured(
      { ...plan, cwd: plan.cwd ?? os.homedir() }, signal, maxOutputBytes
    );
    bridgeOutput?.appendLine(
      `[Agent MCP] [${result.exitCode === 0 ? '完成' : `失败: exit ${result.exitCode}`}] ${displayName}`
    );
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    bridgeOutput?.appendLine(`[Agent MCP] [失败] ${displayName}: ${detail}`);
    throw error;
  }
}

function performanceLine(label: string, startedAt: number): void {
  bridgeOutput?.appendLine(`[性能] ${label}: ${(performance.now() - startedAt).toFixed(1)} ms`);
}

async function timedPhase<T>(label: string, action: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await action();
  } finally {
    performanceLine(label, startedAt);
  }
}

async function promptMasterPassword(
  context: vscode.ExtensionContext, confirm: boolean, force = false
): Promise<string> {
  const stored = await context.secrets.get(masterPasswordSecret);
  if (stored && !force) return stored;
  const password = await input({
    title: '配置密码加密',
    prompt: confirm ? '设置配置加密主口令' : '输入配置加密主口令',
    placeHolder: '此口令用于加密 SSH 密码，请妥善保存',
    password: true,
    validateInput: required('加密主口令')
  });
  if (password === undefined) throw new Error('已取消密码加密');
  if (confirm) {
    const repeated = await input({
      title: '配置密码加密', prompt: '再次输入配置加密主口令', password: true,
      validateInput: required('加密主口令')
    });
    if (repeated === undefined) throw new Error('已取消密码加密');
    if (repeated !== password) throw new Error('两次输入的加密主口令不一致');
  }
  await context.secrets.store(masterPasswordSecret, password);
  return password;
}

async function decryptHostPassword(context: vscode.ExtensionContext, encrypted: string): Promise<string> {
  const stored = await context.secrets.get(masterPasswordSecret);
  if (stored) {
    try {
      return await decryptPassword(encrypted, stored);
    } catch {
      // 单个主机的密文可能已损坏，也可能是主口令已更换。不要删除全局 secret：
      // 其它主机可能仍能用旧口令解密；这里仅对本次解密重新提示。
    }
  }
  const password = await promptMasterPassword(context, false, true);
  const decrypted = await decryptPassword(encrypted, password);
  // 新口令成功解密后才更新全局 secret；失败则保持旧 secret 不动。
  await context.secrets.store(masterPasswordSecret, password);
  return decrypted;
}

async function bridgeMasterPasswordEnv(
  context: vscode.ExtensionContext, host: HostConfig
): Promise<Record<string, string>> {
  if (platformAdapter.kind !== 'wsl' || !host.password) return {};
  const encrypted = isEncryptedPassword(host.password);
  if (encrypted) {
    // This validates a stored value and prompts again immediately if it is
    // stale, rather than failing inside the non-interactive bridge process.
    await decryptHostPassword(context, host.password);
    const masterPassword = await context.secrets.get(masterPasswordSecret);
    if (!masterPassword) throw new Error('无法读取配置加密主口令');
    return { WSL_VPN_MASTER_PASSWORD: masterPassword };
  }
  const masterPassword = await promptMasterPassword(context, true);
  return { WSL_VPN_MASTER_PASSWORD: masterPassword };
}

async function resolveStoredHostPassword(
  context: vscode.ExtensionContext, config: BridgeConfig, host: HostConfig
): Promise<HostConfig> {
  if (!host.password) return host;
  if (isEncryptedPassword(host.password)) {
    return { ...host, password: await decryptHostPassword(context, host.password) };
  }
  const plainPassword = host.password;
  const masterPassword = await promptMasterPassword(context, true);
  const encrypted = await encryptPassword(plainPassword, masterPassword);
  const index = config.hosts.findIndex((item) => item.name === host.name);
  if (index >= 0) config.hosts[index] = { ...host, password: encrypted };
  config.encrypt_passwords = true;
  await saveConfig(configPath(), config);
  return { ...host, password: plainPassword };
}

async function resolvedHost(
  context: vscode.ExtensionContext, hostName: string
): Promise<HostConfig> {
  const config = await readConfig();
  const host = config.hosts.find((candidate) => candidate.name === hostName);
  if (!host) throw new Error(`SSH 主机不存在：${hostName}`);
  if (!host.password) return { ...host };
  if (!isEncryptedPassword(host.password)) return { ...host };
  return {
    ...host,
    password: await decryptPassword(host.password, await promptMasterPassword(context, false))
  };
}

async function selectMount(placeHolder: string): Promise<MountConfig | undefined> {
  const config = await readConfig();
  if (config.mounts.length === 0) {
    throw new ConfigActionRequiredError(
      'No remote folders are configured yet.',
      [addSshConfigAction]
    );
  }
  const picked = await vscode.window.showQuickPick(config.mounts.map((mount) => ({
    label: mount.name,
    description: `${mount.host}: ${mount.remote_path}`,
    mount
  })), { placeHolder });
  return picked?.mount;
}

async function ensureFolder(mount: MountConfig): Promise<RemoteFolder> {
  const existing = registry.get(mount.name);
  if (existing) {
    agentTrace('SFTP', `复用挂载 ${mount.name}，remoteRoot=${existing.remoteRoot}`);
    await pool.get(existing.hostName);
    refreshSafsEntryLabel();
    return existing;
  }
  agentTrace('SFTP', `开始连接挂载 ${mount.name}，host=${mount.host}`);
  const config = await readConfig();
  const resolved = resolveMount(config, mount);
  const session = await pool.get(resolved.hostConfig.name);
  refreshSafsEntryLabel();
  // realpath + stat 一步完成（SCP 回退下合并为单条 exec）。
  const { path: remoteRoot, stat } = await session.statResolved(mount.remote_path);
  if (stat.type !== 'directory') throw new Error(`远程路径不是目录：${remoteRoot}`);
  const placeholder = await ensureAgentCwdPlaceholder(
    remoteRoot, vscodeContext.globalStorageUri.fsPath, mount.name
  );
  const workspaceRoot = vscode.Uri.file(placeholder.localPath).path;
  const folder = { mountName: mount.name, hostName: mount.host, remoteRoot, workspaceRoot };
  registry.set(folder);
  agentTrace(
    'SFTP',
    `挂载 ${mount.name} 验证完成，remoteRoot=${remoteRoot}，agentCwd=${placeholder.localPath}`
  );
  return folder;
}

function folderUri(folder: RemoteFolder, remotePath = folder.remoteRoot): string {
  return remoteUri(folder.mountName, workspacePathForRemote(folder, remotePath));
}

function reportedRemoteTerminalCwd(
  terminal: vscode.Terminal,
  info: NonNullable<ReturnType<typeof managedRemoteTerminals.get>>
): string {
  // VS Code explicitly allows this URI to refer to another machine. In
  // particular, a remote shell may report `file:///remote/path` without a
  // hostname, so rejecting empty/local-looking authorities leaves the cwd
  // permanently stuck at the SSH terminal's startup directory after `cd`.
  const cwd = resolveRemoteTerminalCwdReport(terminal.shellIntegration?.cwd, info.remoteCwd);
  info.remoteCwd = cwd;
  return cwd;
}

function provideSafsTerminalLinks(
  context: vscode.TerminalLinkContext
): SafsTerminalLink[] {
  const info = managedRemoteTerminals.get(context.terminal);
  if (!info) return [];
  const folder = registry.get(info.mount.name);
  if (!folder) return [];
  const remoteCwd = reportedRemoteTerminalCwd(context.terminal, info);
  const location = currentRemoteLocation();
  const searchRoot = location?.mountName === info.mount.name
    && isRemotePathInsideRoot(folder.remoteRoot, location.remotePath)
    ? location.remotePath
    : isRemotePathInsideRoot(folder.remoteRoot, remoteCwd)
      ? remoteCwd
      : folder.remoteRoot;
  return findRemoteTerminalPaths(context.line).map((match) => {
    const remotePath = resolveRemoteTerminalPath(match.path, remoteCwd);
    const insideRoot = isRemotePathInsideRoot(folder.remoteRoot, remotePath);
    return {
      startIndex: match.startIndex,
      length: match.length,
      tooltip: insideRoot
        ? `打开远程文件 ${remotePath}${match.line ? `:${match.line}${
          match.column ? `:${match.column}` : ''
      }` : ''}`
        : `路径超出挂载范围 ${folder.remoteRoot}，点击配置新的 SSH 挂载`,
      mountName: info.mount.name,
      rawPath: match.path,
      remotePath,
      remoteRoot: folder.remoteRoot,
      searchRoot,
      ...(match.line ? { line: match.line } : {}),
      ...(match.column ? { column: match.column } : {})
    };
  });
}

function isRemoteFileNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: string; name?: string };
  return value.code === 'FileNotFound' || value.code === 'ENOENT'
    || value.name === 'EntryNotFound';
}

async function openSafsTerminalRemotePath(
  folder: RemoteFolder, remotePath: string, line?: number, column?: number
): Promise<void> {
  const uri = vscode.Uri.parse(folderUri(folder, remotePath));
  const fileStat = await vscode.workspace.fs.stat(uri);
  if ((fileStat.type & vscode.FileType.Directory) !== 0) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  let selection: vscode.Range | undefined;
  if (line) {
    const targetLine = Math.min(line - 1, Math.max(document.lineCount - 1, 0));
    const targetColumn = Math.min(
      Math.max((column ?? 1) - 1, 0), document.lineAt(targetLine).text.length
    );
    const position = new vscode.Position(targetLine, targetColumn);
    selection = new vscode.Range(position, position);
  }
  await vscode.window.showTextDocument(document, { preview: true, selection });
}

async function handleSafsTerminalLink(link: SafsTerminalLink): Promise<void> {
  const currentRoot = registry.get(link.mountName)?.remoteRoot ?? link.remoteRoot;
  if (!isRemotePathInsideRoot(currentRoot, link.remotePath)) {
    const selected = await vscode.window.showWarningMessage(
      `远程路径 ${link.remotePath} 不在挂载“${link.mountName}”的范围 ${currentRoot} 内。`,
      addTerminalLinkMountAction,
      openTerminalLinkConfigAction
    );
    if (selected === addTerminalLinkMountAction) {
      await vscode.commands.executeCommand(`${commandPrefix}.addSshConfig`);
    } else if (selected === openTerminalLinkConfigAction) {
      await vscode.commands.executeCommand(`${commandPrefix}.openConfig`);
    }
    return;
  }

  let folder = registry.get(link.mountName);
  if (!folder) {
    const config = await readConfig();
    const mount = config.mounts.find((candidate) => candidate.name === link.mountName);
    if (!mount) throw new Error(`远程挂载不存在：${link.mountName}`);
    folder = await ensureFolder(mount);
  }
  // Recheck against the live, server-resolved root in case the configuration
  // changed after the terminal printed this link.
  if (!isRemotePathInsideRoot(folder.remoteRoot, link.remotePath)) {
    throw new Error(`远程路径已超出挂载范围：${link.remotePath}`);
  }
  try {
    await openSafsTerminalRemotePath(folder, link.remotePath, link.line, link.column);
    return;
  } catch (error) {
    if (!isRemoteFileNotFound(error) || path.posix.isAbsolute(link.rawPath)) throw error;
  }

  const session = await pool.get(folder.hostName);
  const { search, cancelled } = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在当前远程工作区查找 ${path.posix.basename(link.rawPath)}…`,
    cancellable: true
  }, async (_progress, token) => {
    const search = await findRemotePathCandidates(
      link.searchRoot,
      link.rawPath,
      async (directory) => {
        try {
          return await session.readDirectory(directory);
        } catch (error) {
          const code = (error as { code?: number | string }).code;
          if (code === 3 || code === 'EACCES' || code === 'EPERM') return [];
          throw error;
        }
      },
      { cancelled: () => token.isCancellationRequested }
    );
    return { search, cancelled: token.isCancellationRequested };
  });
  if (cancelled) return;
  if (search.matches.length === 0) {
    if (search.truncated) {
      void vscode.window.showWarningMessage(
        `未在前 5000 个远程条目中找到 ${link.rawPath}，请在终端输出完整路径。`
      );
      return;
    }
    throw new Error(
      `远程文件不存在：${link.remotePath}；当前工作区内也没有同名路径。`
    );
  }
  const selected = search.matches.length === 1
    ? search.matches[0]
    : (await vscode.window.showQuickPick(
      search.matches.map((remotePath) => ({
        label: path.posix.relative(link.searchRoot, remotePath),
        description: remotePath,
        remotePath
      })),
      {
        title: `选择要打开的远程文件：${path.posix.basename(link.rawPath)}`,
        placeHolder: `找到 ${search.matches.length} 个匹配项`
      }
    ))?.remotePath;
  if (!selected) return;
  bridgeOutput?.appendLine(
    `[终端链接] ${link.remotePath} 不存在，已解析到工作区内的 ${selected}`
  );
  await openSafsTerminalRemotePath(folder, selected, link.line, link.column);
}

function localRootForFolder(folder: RemoteFolder): string {
  return vscode.Uri.from({ scheme: 'file', path: folder.workspaceRoot }).fsPath;
}

async function openDirectoryItem(requested: MountConfig): Promise<void> {
  const forwarding = vscodeContext.globalState
    .get<string[]>(aiForwardMountsKey, []).includes(requested.name);
  agentTrace('Open', `准备打开 ${requested.name}，Agent 转发=${forwarding ? '启用' : '关闭'}`);
  if (forwarding) {
    startAgentHttpRouterLeadership(vscodeContext);
    await ensureAgentHttpRouter(vscodeContext);
    await configureDetectedAgents(vscodeContext, true);
  }
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在连接 ${requested.name}…`,
    cancellable: false
  }, async (progress) => {
    progress.report({ message: '正在验证远程目录…' });
    const folder = await ensureFolder(requested);
    const remoteDirectory = folder.remoteRoot;
    agentTrace('Open', `创建新窗口，workspace=${folderUri(folder, remoteDirectory)}`);
    progress.report({ message: '正在打开工作区…' });
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.parse(folderUri(folder, remoteDirectory)),
      true
    );
  });
}

async function openRemoteDirectory(): Promise<void> {
  const location = currentRemoteLocation();
  if (!location) {
    throw new Error('当前窗口不是 SAFS 远程工作区');
  }
  const config = await readConfig();
  const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
    if (!mount) throw new Error(`远程目录配置不存在：${location.mountName}`);
  const folder = await ensureFolder(mount);
  const session = await pool.get(folder.hostName);
  const requested = await promptRemoteDirectory(
    session, folder.remoteRoot, location.remotePath, mount.name
  );
  if (requested === undefined) return;
  const candidate = requested.trim().startsWith('/')
    ? path.posix.normalize(requested.trim())
    : path.posix.resolve(location.remotePath, requested.trim());
  if (!isRemotePathInsideRoot(folder.remoteRoot, candidate)) {
    throw new Error(`远程目录必须位于挂载根目录 ${folder.remoteRoot} 内`);
  }
  const resolved = await session.realpath(candidate);
  if (!isRemotePathInsideRoot(folder.remoteRoot, resolved)) {
    throw new Error(`远程目录必须位于挂载根目录 ${folder.remoteRoot} 内`);
  }
  if ((await session.stat(resolved)).type !== 'directory') {
    throw new Error(`远程路径不是目录：${resolved}`);
  }
  const forwarding = vscodeContext.globalState
    .get<string[]>(aiForwardMountsKey, []).includes(mount.name);
  agentTrace('Open', `准备在新窗口打开 ${mount.name}:${resolved}，Agent 转发=${forwarding ? '启用' : '关闭'}`);
  if (forwarding) {
    startAgentHttpRouterLeadership(vscodeContext);
    await ensureAgentHttpRouter(vscodeContext);
    await configureDetectedAgents(vscodeContext, true);
  }
  const localRoot = localRootForFolder(folder);
  await ensureAgentCwdSubdirectory(localRoot, folder.remoteRoot, resolved);
  await writeLastRemoteDirectory(localRoot, folder.remoteRoot, resolved);
  await recordDirectoryHistory(vscodeContext, mount.name, resolved);
  agentTrace('Open', `创建新窗口打开远程目录：${resolved}`);
  await vscode.commands.executeCommand(
    'vscode.openFolder', vscode.Uri.parse(folderUri(folder, resolved)), true
  );
}

async function switchRemoteDirectory(): Promise<void> {
  const location = currentRemoteLocation();
  if (!location) {
    throw new Error('当前窗口不是 SAFS 远程工作区');
  }
  const config = await readConfig();
  const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
    if (!mount) throw new Error(`远程目录配置不存在：${location.mountName}`);
  const folder = await ensureFolder(mount);
  const session = await pool.get(folder.hostName);
  const requested = await promptRemoteDirectory(
    session, folder.remoteRoot, location.remotePath, mount.name
  );
  if (requested === undefined) return;
  const candidate = requested.trim().startsWith('/')
    ? path.posix.normalize(requested.trim())
    : path.posix.resolve(location.remotePath, requested.trim());
  if (!isRemotePathInsideRoot(folder.remoteRoot, candidate)) {
    throw new Error(`远程目录必须位于挂载根目录 ${folder.remoteRoot} 内`);
  }
  const resolved = await session.realpath(candidate);
  if (!isRemotePathInsideRoot(folder.remoteRoot, resolved)) {
    throw new Error(`远程目录必须位于挂载根目录 ${folder.remoteRoot} 内`);
  }
  if ((await session.stat(resolved)).type !== 'directory') {
    throw new Error(`远程路径不是目录：${resolved}`);
  }
  const localRoot = localRootForFolder(folder);
  await ensureAgentCwdSubdirectory(localRoot, folder.remoteRoot, resolved);
  await writeLastRemoteDirectory(localRoot, folder.remoteRoot, resolved);
  await recordDirectoryHistory(vscodeContext, mount.name, resolved);
  agentTrace('Open', `切换远程目录：${location.remotePath} -> ${resolved}`);
  await vscode.commands.executeCommand(
    'vscode.openFolder', vscode.Uri.parse(folderUri(folder, resolved))
  );
}

async function promptRemoteDirectory(
  session: import('./sftp/session').SftpSession,
  remoteRoot: string,
  currentPath: string,
  mountName: string
): Promise<string | undefined> {
  const picker = vscode.window.createQuickPick<vscode.QuickPickItem>();
  picker.title = `打开远程目录：${mountName}`;
  picker.placeholder = `输入路径，Tab 补全，回车进入`;
  picker.value = currentPath.endsWith('/') ? currentPath : `${currentPath}/`;
  // No items => no dropdown; completion is driven by the Tab keybinding.
  picker.items = [];
  const state: DirectoryPickerState = { picker, session, remoteRoot, currentPath };
  activeDirectoryPicker = state;
  void vscode.commands.executeCommand('setContext', directoryPickerContextKey, true);
  return new Promise<string | undefined>((resolve) => {
    let accepted = false;
    picker.onDidAccept(() => {
      accepted = true;
      clearActiveDirectoryPicker(state);
      picker.hide();
      resolve(picker.value);
    });
    picker.onDidHide(() => {
      clearActiveDirectoryPicker(state);
      picker.dispose();
      if (!accepted) resolve(undefined);
    });
    picker.show();
  });
}

// ---- Tab completion for the directory picker ----

const directoryPickerContextKey = 'safs.directoryPickerVisible';

interface DirectoryPickerState {
  picker: vscode.QuickPick<vscode.QuickPickItem>;
  session: import('./sftp/session').SftpSession;
  remoteRoot: string;
  currentPath: string;
}

let activeDirectoryPicker: DirectoryPickerState | undefined;

function clearActiveDirectoryPicker(state: DirectoryPickerState): void {
  if (activeDirectoryPicker === state) {
    activeDirectoryPicker = undefined;
    void vscode.commands.executeCommand('setContext', directoryPickerContextKey, false);
  }
}

function commonPrefix(names: string[]): string {
  let prefix = names[0] ?? '';
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

async function completeRemoteDirectory(): Promise<void> {
  const state = activeDirectoryPicker;
  if (!state) return;
  const { picker, session, remoteRoot, currentPath } = state;
  const typed = picker.value.trim();
  const absolute = typed.startsWith('/')
    ? path.posix.normalize(typed)
    : path.posix.resolve(currentPath, typed || '.');
  if (!isRemotePathInsideRoot(remoteRoot, absolute)) return;
  const [parent, base] = typed.endsWith('/') || absolute === remoteRoot
    ? [absolute, '']
    : [path.posix.dirname(absolute), path.posix.basename(absolute)];
  try {
    const entries = (await session.readDirectory(parent))
      .filter((entry) => entry.type === 'directory' || entry.type === 'symbolic-link')
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    if (base) {
      const matches = entries.filter((name) => name.startsWith(base));
      if (matches.length === 1) {
        picker.value = `${parent}/${matches[0]}/`;
      } else if (matches.length > 1) {
        const common = commonPrefix(matches);
        picker.value = common.length > base.length
          ? `${parent}/${common}`
          : `${parent}/${matches[0]}/`;
      }
    } else if (entries.length > 0) {
      picker.value = `${parent}/${entries[0]}/`;
    }
  } catch {
    // Completion is best-effort; ignore remote failures.
  }
}

/**
 * Returns the remote directory containing the currently open remote file of
 * the given mount, or undefined when none is active. No waiting: if the
 * terminal opens before the restored file tab is active, the live-sync
 * listener moves the terminal there once the editor becomes active.
 */
async function activeRemoteFileDirectory(mountName: string): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor
    ?? vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.scheme === remoteFileSystemScheme
        || candidate.document.uri.scheme === 'file'
    );
  const uri = editor?.document.uri;
  if (!uri) return undefined;
  const location = terminalRemoteLocationForUri(uri);
  return location?.mountName === mountName
    ? path.posix.dirname(location.remotePath)
    : undefined;
}

/** 把远程 URI 或同步镜像中的本地文件统一解析为远程位置。 */
function terminalRemoteLocationForUri(
  uri: vscode.Uri
): { mountName: string; remotePath: string } | undefined {
  if (uri.scheme === remoteFileSystemScheme) {
    try {
      const location = parseRemoteUri(uri.toString());
      const folder = registry.get(location.mountName);
      if (!folder) return undefined;
      return {
        mountName: location.mountName,
        remotePath: remotePathForUri(folder, location.remotePath)
      };
    } catch {
      return undefined;
    }
  }
  if (uri.scheme !== 'file') return undefined;
  return syncedRemoteLocation(uri.fsPath);
}

/**
 * Metadata for the remote file or synchronized local mirror file currently
 * open in the active editor (falling back to the first matching visible
 * editor), or null when none is active. Computed live on every call.
 * The remote stat is best-effort: a file deleted on the remote still resolves
 * with exists=false so callers can distinguish "file gone" from "no active
 * file". `mountName` optionally filters to one mount (the active file of any
 * other mount is never reported).
 */
async function activeRemoteFile(mountName?: string): Promise<{
  mountName: string;
  path: string;
  relative: string;
  size: number | null;
  modified: number | null;
  dirty: boolean;
  exists: boolean;
} | null> {
  const editor = vscode.window.activeTextEditor
    ?? vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.scheme === remoteFileSystemScheme
        || candidate.document.uri.scheme === 'file'
    );
  const uri = editor?.document.uri;
  if (!uri) return null;
  const location = terminalRemoteLocationForUri(uri);
  if (!location) return null;
  if (mountName && location.mountName !== mountName) return null;
  let folder = registry.get(location.mountName);
  if (!folder) {
    const config = await readConfig();
    const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
    if (!mount) return null;
    folder = await ensureFolder(mount);
  }
  const filePath = location.remotePath;
  const relative = path.posix.relative(folder.remoteRoot, filePath);
  // 活动编辑器 URI 理论上必在挂载根内；防御性校验，避免越界路径泄漏。
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    return null;
  }
  let stat: { size: number; mtime: number } | undefined;
  try {
    const value = await (await pool.get(folder.hostName)).stat(filePath);
    if (value.type === 'file') stat = { size: value.size, mtime: value.mtime };
  } catch {
    // The file may have been deleted remotely; report exists=false.
  }
  return {
    mountName: folder.mountName,
    path: filePath,
    relative,
    size: stat?.size ?? null,
    modified: stat?.mtime ?? null,
    dirty: editor?.document.isDirty ?? false,
    exists: stat !== undefined
  };
}

/**
 * Live-sync: when the active editor switches to a remote file, send `cd` to
 * every managed terminal of that mount so the terminal follows the file's
 * directory (only when the directory actually changed, to avoid noise).
 */
async function syncTerminalToActiveFile(uri: vscode.Uri): Promise<void> {
  try {
    const location = terminalRemoteLocationForUri(uri);
    if (!location) return;
    const fileDir = path.posix.dirname(location.remotePath);
    const restoreFollow = restoredFileSyncPending.has(location.mountName);
    const follows = settings().get<boolean>('terminalFollowsActiveFile', false)
      || restoreFollow;
    if (!follows) return;
    let synced = false;
    for (const [terminal, info] of managedRemoteTerminals) {
      if (info.mount.name !== location.mountName || info.remoteCwd === fileDir) continue;
      info.remoteCwd = fileDir;
      if (info.pty) {
        // 内置终端：shell 通道就绪前入队，就绪后补发，避免 cd 被丢弃。
        info.pty.sendInput(`cd -- ${shellQuote(fileDir)}\r`);
      } else {
        terminal.sendText(`cd -- ${shellQuote(fileDir)}`, true);
      }
      synced = true;
    }
    // 只有真正把终端移过去后才消费重开标志；否则（终端尚未创建等时序）
    // 保留标志，等待下一次文件激活或延迟补检。
    if (synced) restoredFileSyncPending.delete(location.mountName);
  } catch (error) {
    logAsyncFailure('终端目录跟随失败', error);
  }
}

/** 非阻塞延迟补检：覆盖“文件标签页先激活、终端后创建”的时序窗口。 */
function deferRestoreFollow(mountName: string): void {
  setTimeout(() => {
    void (async () => {
      if (!restoredFileSyncPending.has(mountName)) return;
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri?.scheme === remoteFileSystemScheme || uri?.scheme === 'file') {
        await syncTerminalToActiveFile(uri);
      }
    })();
  }, 1500);
}

// ---- 远程同步到本地 ----

async function syncToLocal(uri?: vscode.Uri): Promise<void> {
  const resolvedUri = uri && uri.scheme === remoteFileSystemScheme
    ? uri
    : vscode.window.activeTextEditor?.document.uri;
  if (!resolvedUri || resolvedUri.scheme !== remoteFileSystemScheme) {
    throw new Error('请先在远程文件/目录上右键使用“同步到本地”');
  }
  const location = parseRemoteUri(resolvedUri.toString());
  const folder = registry.get(location.mountName);
  if (!folder) throw new Error(`远程挂载未连接：${location.mountName}`);
  const remotePath = remotePathForUri(folder, location.remotePath);
  const manager = syncManager;
  if (!manager) throw new Error('远程同步尚未就绪');
  if (manager.has(location.mountName, remotePath)) {
    const existingTask = manager.list().find(
      (task) => task.mountName === location.mountName && task.remotePath === remotePath
    );
    const choice = await vscode.window.showInformationMessage(
      `“${remotePath}”已在同步中。`, '停止同步'
    );
    if (choice === '停止同步') {
      await syncCoordinator?.requestStop(location.mountName, remotePath);
      if (existingTask) {
        await syncCoordinator?.clearReady(
          location.mountName, remotePath, existingTask.localDir
        );
      }
      manager.remove(location.mountName, remotePath);
      saveSyncTasks();
    }
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    title: '选择同步目标目录',
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '选择目录',
    // 固定打开用户家目录。
    defaultUri: vscode.Uri.file(os.homedir())
  });
  if (!picked || picked.length === 0) return;
  // 本地目标：远程目录 → 所选目录下的同名子目录；远程文件 → 同名文件。
  const baseName = path.posix.basename(remotePath);
  const localTarget = path.join(picked[0].fsPath, baseName);
  const resetLocalOnFirstSync = await confirmInitialSyncTarget(localTarget);
  if (resetLocalOnFirstSync === undefined) return;
  const task: RemoteSyncTask = {
    mountName: location.mountName,
    remotePath,
    localDir: localTarget,
    resetLocalOnFirstSync
  };
  await syncCoordinator?.clearReady(location.mountName, remotePath, localTarget);
  await syncCoordinator?.clearStop(location.mountName, remotePath);
  if (!await startRemoteSyncWithProgress(manager, task)) return;
  void vscode.window.showInformationMessage(
    `已开始同步：${remotePath} → ${localTarget}`
  );
}

async function confirmInitialSyncTarget(localDir: string): Promise<boolean | undefined> {
  const targetStat = await stat(localDir).catch(() => undefined);
  if (!targetStat) return false;
  const hasContent = !targetStat.isDirectory() || (await readdir(localDir)).length > 0;
  if (!hasContent) return false;
  const choice = await vscode.window.showWarningMessage(
    `本地目标 ${localDir} 已有内容。首次同步将以远程目录为准，删除本地独有内容并覆盖同名文件。是否继续？`,
    { modal: true },
    '继续同步'
  );
  return choice === '继续同步' ? true : undefined;
}

async function enableHistorySync(item: HistoryItem): Promise<void> {
  if (historySyncTask(item)) return;
  const confirmed = await vscode.window.showInformationMessage(
    `确认将远程目录 ${item.path}/ 同步到本地以提升 VS Code 插件兼容性？`,
    { modal: true },
    '开启同步'
  );
  if (confirmed !== '开启同步') return;
  const picked = await vscode.window.showOpenDialog({
    title: '选择同步目标目录',
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '选择目录',
    defaultUri: vscode.Uri.file(os.homedir())
  });
  if (!picked?.length) return;
  const manager = syncManager;
  if (!manager) throw new Error('远程同步尚未就绪');
  const localDir = path.join(picked[0].fsPath, path.posix.basename(item.path));
  const resetLocalOnFirstSync = await confirmInitialSyncTarget(localDir);
  if (resetLocalOnFirstSync === undefined) return;
  await syncCoordinator?.clearReady(item.mountName, item.path, localDir);
  await syncCoordinator?.clearStop(item.mountName, item.path);
  if (!await startRemoteSyncWithProgress(manager, {
    mountName: item.mountName, remotePath: item.path, localDir, resetLocalOnFirstSync
  })) return;
  void vscode.window.showInformationMessage(`已开始同步：${item.path} → ${localDir}`);
}

async function disableHistorySync(item: HistoryItem): Promise<void> {
  await syncCoordinator?.requestStop(item.mountName, item.path);
  const task = historySyncTask(item);
  syncManager?.remove(item.mountName, item.path);
  if (task) await syncCoordinator?.clearReady(item.mountName, item.path, task.localDir);
}

// ---- SAFS：可视化下载（大文件流式 + 进度 + 可取消） ----

function formatDownloadBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function startRemoteSyncWithProgress(
  manager: RemoteSyncManager, task: RemoteSyncTask
): Promise<boolean> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `SAFS：同步 ${path.posix.basename(task.remotePath)} 到本地`,
    cancellable: true
  }, async (progress, token) => {
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    let reportedPercent = 0;
    progress.report({ message: '正在扫描远程目录…' });
    try {
      await manager.add(task, {
        signal: controller.signal,
        onProgress: (state) => {
          if (state.phase === 'scanning') {
            progress.report({ message: '正在统计文件数量和大小…' });
            return;
          }
          const percent = state.totalBytes > 0
            ? Math.min(100, state.transferredBytes / state.totalBytes * 100)
            : state.totalFiles > 0
              ? state.completedFiles / state.totalFiles * 100
              : 100;
          const increment = Math.max(0, percent - reportedPercent);
          reportedPercent = Math.max(reportedPercent, percent);
          const file = state.currentFile ? path.posix.basename(state.currentFile) : '';
          progress.report({
            message: `${file} · ${state.completedFiles}/${state.totalFiles} 个文件 · ${
              formatDownloadBytes(state.transferredBytes)
            }/${formatDownloadBytes(state.totalBytes)}（${Math.floor(percent)}%）`,
            increment
          });
        }
      });
      if (controller.signal.aborted) {
        void vscode.window.showInformationMessage(`已取消同步 ${task.remotePath}。`);
        return false;
      }
      return true;
    } finally {
      cancellation.dispose();
    }
  });
}

async function visualDownload(uri?: vscode.Uri): Promise<void> {
  const resolvedUri = uri && uri.scheme === remoteFileSystemScheme
    ? uri
    : vscode.window.activeTextEditor?.document.uri;
  if (!resolvedUri || resolvedUri.scheme !== remoteFileSystemScheme) {
    throw new Error('请先在远程文件/目录上右键使用"SAFS：可视化下载"');
  }
  const location = parseRemoteUri(resolvedUri.toString());
  const folder = registry.get(location.mountName);
  if (!folder) throw new Error(`远程挂载未连接：${location.mountName}`);
  const remotePath = remotePathForUri(folder, location.remotePath);
  const session = await pool.get(folder.hostName);
  const stat = await session.stat(remotePath);
  if (stat.type === 'directory') {
    await downloadRemoteDirectory(session, remotePath);
  } else {
    await downloadRemoteFile(session, remotePath, stat.size);
  }
}

async function downloadRemoteFile(
  session: SftpSession, remotePath: string, totalBytes: number
): Promise<void> {
  const baseName = path.posix.basename(remotePath);
  const picked = await vscode.window.showSaveDialog({
    title: 'SAFS：下载到',
    defaultUri: vscode.Uri.file(path.join(os.homedir(), baseName)),
    saveLabel: '下载'
  });
  if (!picked) return;
  const target = picked.fsPath;
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在下载 ${baseName}`,
    cancellable: true
  }, async (progress, token) => {
    const controller = new AbortController();
    const onCancelled = token.onCancellationRequested(() => controller.abort());
    let cumulative = 0;
    // 立即上报一次：通知一出现即带文件名/大小，而不是等跨过 1% 才显示。
    progress.report({
      message: `${baseName}：0 B / ${formatDownloadBytes(totalBytes)}（0%）`
    });
    try {
      const source = await session.readFileStream(remotePath, controller.signal);
      await writeStreamToFile(source, target, {
        onDelta: (delta) => {
          cumulative += delta;
          const percent = totalBytes > 0 ? cumulative / totalBytes * 100 : 0;
          progress.report({
            message: totalBytes > 0
              ? `${baseName}：${formatDownloadBytes(cumulative)} / ${formatDownloadBytes(totalBytes)}（${Math.floor(percent)}%）`
              : `${baseName}：${formatDownloadBytes(cumulative)}`,
            increment: totalBytes > 0 ? delta / totalBytes * 100 : undefined
          });
        },
        signal: controller.signal
      });
      progress.report({
        message: `完成：${baseName}（${formatDownloadBytes(totalBytes)}）`,
        increment: totalBytes > 0 ? 100 - cumulative / totalBytes * 100 : undefined
      });
    } catch (error) {
      if (controller.signal.aborted) {
        // writeStreamToFile 已删除半成品文件。
        void vscode.window.showInformationMessage(`已取消下载 ${baseName}。`);
        return;
      }
      throw error;
    } finally {
      onCancelled.dispose();
    }
  });
}

async function downloadRemoteDirectory(
  session: SftpSession, remotePath: string
): Promise<void> {
  const baseName = path.posix.basename(remotePath);
  const picked = await vscode.window.showOpenDialog({
    title: 'SAFS：选择下载目标目录',
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '下载到这里',
    defaultUri: vscode.Uri.file(os.homedir())
  });
  if (!picked || picked.length === 0) return;
  const targetRoot = path.join(picked[0].fsPath, baseName);
  // 先统计文件清单与总大小（复用指纹扫描，readDirectory 已带 size，无额外 stat）。
  const lines = await scanRemote(session, remotePath);
  const files: Array<{ rel: string; size: number }> = [];
  let totalBytes = 0;
  for (const line of lines) {
    if (!line.startsWith('f:')) continue;
    const rel = line.slice(2, line.indexOf(':', 2));
    const size = Number((line.slice(rel.length + 2).match(/^\d+/) ?? ['0'])[0]);
    files.push({ rel, size });
    totalBytes += size;
  }
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在下载目录 ${baseName}`,
    cancellable: true
  }, async (progress, token) => {
    const controller = new AbortController();
    const onCancelled = token.onCancellationRequested(() => controller.abort());
    let cumulative = 0;
    let currentFile = '';
    progress.report({
      message: `${baseName}：0 B / ${formatDownloadBytes(totalBytes)}（0%）`
    });
    try {
      for (const file of files) {
        if (controller.signal.aborted) break;
        // 显示"根目录名 + 相对路径"（如 AF3/af3.bin.zst），与上传一致。
        currentFile = path.posix.join(baseName, file.rel);
        const source = await session.readFileStream(
          path.posix.join(remotePath, file.rel), controller.signal
        );
        await writeStreamToFile(source, path.join(targetRoot, ...file.rel.split('/')), {
          onDelta: (delta) => {
            cumulative += delta;
            const percent = totalBytes > 0 ? cumulative / totalBytes * 100 : 0;
            progress.report({
              message: totalBytes > 0
                ? `${currentFile}：${formatDownloadBytes(cumulative)} / ${formatDownloadBytes(totalBytes)}（${Math.floor(percent)}%）`
                : `${currentFile}：${formatDownloadBytes(cumulative)}`,
              increment: totalBytes > 0 ? delta / totalBytes * 100 : undefined
            });
          },
          signal: controller.signal
        });
      }
      if (controller.signal.aborted) {
        // 当前文件的半成品已被 writeStreamToFile 删除；已完成的文件保留。
        void vscode.window.showInformationMessage(
          `已取消下载目录 ${baseName}（已完成的文件已保留）。`
        );
        return;
      }
      progress.report({
        message: `完成：${formatDownloadBytes(totalBytes)}`,
        increment: totalBytes > 0 ? 100 - cumulative / totalBytes * 100 : undefined
      });
    } catch (error) {
      if (controller.signal.aborted) {
        void vscode.window.showInformationMessage(`已取消下载目录 ${baseName}。`);
        return;
      }
      throw error;
    } finally {
      onCancelled.dispose();
    }
  });
}

// ---- SAFS：可视化上传（本地 → 远程，流式 + 进度 + 可取消） ----

async function visualUpload(...resources: vscode.Uri[]): Promise<void> {
  const sources = await collectUploadSources(resources);
  if (sources.length === 0) return;
  // 第一步：选择远程挂载（来自 ~/.safs/config.json，无需打开远程目录）。
  const mount = await selectMount('选择要上传到的远程挂载');
  if (!mount) return;
  const config = await readConfig();
  const resolved = resolveMount(config, mount);
  const session = await pool.get(resolved.hostConfig.name);
  const remoteRoot = await session.realpath(mount.remote_path);
  // 第二步：选择/输入远程目标目录（Tab 补全、回车确认）。
  const picked = await promptRemoteDirectory(session, remoteRoot, remoteRoot, mount.name);
  if (!picked) return;
  const targetDir = picked.startsWith('/') ? picked : path.posix.join(remoteRoot, picked);
  const plan = await planUploads(sources, targetDir);
  if (plan.files.length === 0) {
    void vscode.window.showInformationMessage('没有可上传的文件。');
    return;
  }
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在上传到 ${mount.name}:${targetDir}`,
    cancellable: true
  }, async (progress, token) => {
    const controller = new AbortController();
    const onCancelled = token.onCancellationRequested(() => controller.abort());
    let cumulative = 0;
    let currentName = '';
    let currentRemote = '';
    progress.report({
      message: `0 B / ${formatDownloadBytes(plan.totalBytes)}（0%）`
    });
    try {
      // 一次性创建全部远程目录（含目标根与空目录），再逐文件上传。
      for (const dir of plan.dirs) {
        if (controller.signal.aborted) break;
        await ensureRemoteDir(session, dir);
      }
      for (const file of plan.files) {
        if (controller.signal.aborted) break;
        // 显示相对目标目录的路径（含源目录名，如 AF3/af3.bin.zst），
        // 避免同名文件在不同目录下分不清。
        currentName = path.posix.relative(targetDir, file.remote) || path.basename(file.local);
        currentRemote = file.remote;
        const source = createReadStream(file.local);
        const target = await session.writeFileStream(
          file.remote, { create: true, overwrite: true }, controller.signal
        );
        await pipeStreams(source, target, {
          onDelta: (delta) => {
            cumulative += delta;
            const percent = plan.totalBytes > 0
              ? cumulative / plan.totalBytes * 100
              : 0;
            progress.report({
              message: plan.totalBytes > 0
                ? `${currentName}：${formatDownloadBytes(cumulative)} / ${formatDownloadBytes(plan.totalBytes)}（${Math.floor(percent)}%）`
                : `${currentName}：${formatDownloadBytes(cumulative)}`,
              increment: plan.totalBytes > 0 ? delta / plan.totalBytes * 100 : undefined
            });
          },
          signal: controller.signal
        });
      }
      if (controller.signal.aborted) {
        void vscode.window.showInformationMessage(
          '已取消上传（已完成的文件已保留）。'
        );
        return;
      }
      progress.report({
        message: `完成：${plan.files.length} 个文件（${formatDownloadBytes(plan.totalBytes)}）`,
        increment: plan.totalBytes > 0 ? 100 - cumulative / plan.totalBytes * 100 : undefined
      });
    } catch (error) {
      if (controller.signal.aborted) {
        // 当前文件的远端半成品已中断，删除避免残留。
        void session.deleteFile(currentRemote).catch(() => undefined);
        void vscode.window.showInformationMessage('已取消上传。');
        return;
      }
      throw error;
    } finally {
      onCancelled.dispose();
    }
  });
}

/** 收集上传源：右键传入的本地 URI，或命令面板调用时弹文件选择器。 */
async function collectUploadSources(resources: vscode.Uri[]): Promise<string[]> {
  const paths = resources
    .filter((uri) => uri && uri.scheme === 'file')
    .map((uri) => uri.fsPath);
  if (paths.length > 0) return paths;
  const picked = await vscode.window.showOpenDialog({
    title: 'SAFS：选择要上传的文件/目录',
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: '选择上传',
    defaultUri: vscode.Uri.file(os.homedir())
  });
  return picked?.map((uri) => uri.fsPath) ?? [];
}

function currentRemoteLocation(): { mountName: string; remotePath: string } | undefined {
  const resolveLocation = (location: { mountName: string; remotePath: string }) => {
    const folder = registry.get(location.mountName);
    if (!folder || !isRemotePathInsideRoot(folder.workspaceRoot, location.remotePath)) {
      return undefined;
    }
    return { ...location, remotePath: remotePathForUri(folder, location.remotePath) };
  };
  const workspace = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.uri.scheme === remoteFileSystemScheme
  );
  if (workspace) return resolveLocation(parseRemoteUri(workspace.uri.toString()));
  // 同步镜像是 file:// 工作区，但语义上仍绑定到对应的远程目录。
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    const location = syncedRemoteLocation(folder.uri.fsPath);
    if (location) return location;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === remoteFileSystemScheme) {
    return resolveLocation(parseRemoteUri(active.toString()));
  }
  if (active?.scheme === 'file') return syncedRemoteLocation(active.fsPath);
  return undefined;
}

// ---- openTerminal (aligned with main) ----

async function createTerminalDiagnostic(
  context: vscode.ExtensionContext, mountName: string, command: string
): Promise<{ file: string; command: string } | undefined> {
  try {
    const directory = path.join(context.globalStorageUri.fsPath, 'terminal-logs');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const safeMount = mountName.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 50) || 'remote';
    return {
      file: path.join(
        directory, `${safeMount}-${Date.now()}-${randomBytes(6).toString('hex')}.stderr.log`
      ),
      command
    };
  } catch (error) {
    bridgeOutput?.appendLine(
      `[终端诊断] 无法创建诊断目录，终端 stderr 将无法持久化：${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}

async function recoverTerminalDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  const directory = path.join(context.globalStorageUri.fsPath, 'terminal-logs');
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logAsyncFailure('终端诊断恢复失败', error);
    }
    return;
  }
  for (const name of names.filter((candidate) => candidate.endsWith('.stderr.log'))) {
    const file = path.join(directory, name);
    try {
      const cleaned = cleanTerminalDiagnostic(
        redactSensitiveText(decodeTerminalDiagnostic(await readFile(file)))
      );
      if (cleaned.text) {
        bridgeOutput?.appendLine(
          `[终端 stderr] 恢复上次未正常回收的诊断 ${name}${
            cleaned.truncated ? '（仅保留末尾 64 KiB）' : ''
          }\n${cleaned.text}`
        );
      }
      await unlink(file);
    } catch (error) {
      logAsyncFailure(`终端诊断恢复失败 ${name}`, error);
    }
  }
}

async function logManagedTerminalExit(
  terminal: vscode.Terminal,
  info: NonNullable<ReturnType<typeof managedRemoteTerminals.get>>
): Promise<string> {
  const status = terminal.exitStatus;
  bridgeOutput?.appendLine(
    `[终端] ${terminal.name} 已关闭；mount=${info.mount.name}；exit=${
      status?.code ?? 'unknown'
    }；reason=${status?.reason ?? 'unknown'}`
  );
  const diagnostic = info.diagnostic;
  if (!diagnostic) return '';
  let diagnosticText = '';
  try {
    const raw = decodeTerminalDiagnostic(await readFile(diagnostic.file));
    const cleaned = cleanTerminalDiagnostic(redactSensitiveText(raw));
    diagnosticText = cleaned.text;
    if (cleaned.text) {
      bridgeOutput?.appendLine(
        `[终端 stderr] $ ${diagnostic.command}${cleaned.truncated ? '（仅保留末尾 64 KiB）' : ''}\n${
          cleaned.text
        }`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      bridgeOutput?.appendLine(
        `[终端诊断] 读取 ${diagnostic.file} 失败：${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  } finally {
    await unlink(diagnostic.file).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        bridgeOutput?.appendLine(
          `[终端诊断] 清理 ${diagnostic.file} 失败：${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    });
  }
  return diagnosticText;
}

async function suggestReopeningClosedTerminal(terminal: vscode.Terminal): Promise<void> {
  const reopen = managedRemoteTerminals.get(terminal);
  managedRemoteTerminals.delete(terminal);
  if (!reopen) return;
  const diagnosticText = await logManagedTerminalExit(terminal, reopen);
  if (terminal.exitStatus?.reason !== vscode.TerminalExitReason.Process) {
    return;
  }
  // Reconnect into the remote directory currently open in this window
  // (kept in sync by SAFS: 切换远程目录), falling back to the cwd the
  // terminal was originally opened with.
  const location = currentRemoteLocation();
  const remoteCwd = location && location.mountName === reopen.mount.name
    ? location.remotePath
    : reopen.remoteCwd;
  if (isOpenSshHostKeyVerificationFailure(diagnosticText)) {
    const retry = reopen.hostKeyRetries ?? 0;
    if (retry < maxOpenSshHostKeyRetries) {
      bridgeOutput?.appendLine(
        `[主机密钥] 终端连接命中尚未记录的负载节点，重新探测并重连（${
          retry + 1
        }/${maxOpenSshHostKeyRetries}）`
      );
      await openTerminal(
        vscodeContext, reopen.mount, remoteCwd, undefined, true, true, retry + 1
      );
      return;
    }
    void vscode.window.showErrorMessage(
      `远程终端“${terminal.name}”连续遇到未确认的负载节点，已停止自动重连。`
    );
    return;
  }
  if (reopen.retryWithSystemSsh) {
    void vscode.window.showInformationMessage(
      `SAFS: 内置终端与该服务器不兼容，已改用系统 SSH 重连“${reopen.mount.name}”。`
    );
    await openTerminal(vscodeContext, reopen.mount, remoteCwd, undefined, true, true);
    return;
  }
  const selected = await vscode.window.showInformationMessage(
    `远程终端“${terminal.name}”已退出。`,
    reconnectRemoteTerminalAction,
    viewSafsLogAction
  );
  if (selected === reconnectRemoteTerminalAction) {
    await openTerminal(vscodeContext, reopen.mount, remoteCwd, undefined, true);
  } else if (selected === viewSafsLogAction) {
    bridgeOutput?.show(true);
  }
}

/**
 * Warm the OpenSSH capability cache used to build legacy algorithm flags.
 * WSL terminals go through the bundled bridge script, which does its own
 * version probing, so they do not need this.
 */
async function warmSshCliCapabilities(): Promise<void> {
  if (platformAdapter.kind === 'wsl') return;
  await ensureSshCapabilities(await resolveExecutable('ssh'));
}

async function openTerminal(
  context: vscode.ExtensionContext, requestedMount?: MountConfig, requestedRemoteCwd?: string,
  loadedConfig?: BridgeConfig, forceNew = false, forceSystemSsh = false,
  hostKeyRetries = 0
): Promise<{ terminal: vscode.Terminal; created: boolean } | undefined> {
  const config = loadedConfig ?? await readConfig();
  const location = requestedMount ? undefined : currentRemoteLocation();
  const mount = requestedMount
    ?? config.mounts.find((candidate) => candidate.name === location?.mountName)
    ?? await selectMount('Select a remote terminal');
  if (!mount) return undefined;
  const folder = await ensureFolder(mount);
  // Use the server-resolved root. Configured roots such as "." are relative
  // to the SSH login directory and cannot be compared directly with the
  // absolute paths stored in remote workspace URIs.
  const remoteRoot = folder.remoteRoot;
  let remoteCwd = requestedRemoteCwd
    ?? (location?.mountName === mount.name ? location.remotePath : folder.remoteRoot);
  // 打开终端始终跟随当前打开的远程文件所在目录（无条件，含重开窗口归位）；
  // 仅“切换/打开文件时实时 cd”才由 safs.terminalFollowsActiveFile 控制。
  const fileDirectory = await activeRemoteFileDirectory(mount.name);
  if (fileDirectory) {
    remoteCwd = fileDirectory;
    // openTerminal 已直接把终端放到文件目录，重开归位无需再补检。
    restoredFileSyncPending.delete(mount.name);
  }
  const remoteRelative = remoteCwd ? path.posix.relative(remoteRoot, remoteCwd) : '';
  const terminalName = remoteRelative
    ? `SSH: ${mount.name} — ${remoteRelative}`
    : `SSH: ${mount.name}`;
  const terminalId = `${mount.name}\0${remoteRelative}`;
  if (!forceNew) {
    const existingTerminal = vscode.window.terminals.find((terminal) => {
      const options = terminal.creationOptions;
      const identity = 'env' in options ? options.env?.[terminalIdentityEnv] : undefined;
      return identity === terminalId || terminal.name === terminalName;
    });
    if (existingTerminal) {
      existingTerminal.show();
      return { terminal: existingTerminal, created: false };
    }
  }
  if (openingTerminalIds.has(terminalId)) return undefined;
  openingTerminalIds.add(terminalId);
  try {
    const resolved = resolveMount(config, mount);
    let credentials: AskpassCredentials | undefined;
    if (resolved.hostConfig.password) {
      resolved.hostConfig = await timedPhase(
        `${mount.name} 终端凭据准备`,
        () => resolveStoredHostPassword(context, config, resolved.hostConfig)
      );
    }
    // Direct password terminals use ssh2 on all platforms. The actual terminal
    // connection performs the VS Code host-key confirmation, avoiding the race
    // where ssh-keyscan verifies one backend and system ssh reaches another.
    const useBuiltinSsh = shouldUseBuiltinSshTerminal(
      platformAdapter.kind, resolved.hostConfig, forceSystemSsh
    );
    if (!useBuiltinSsh && resolved.hostConfig.password
      && platformUsesAskpass(platformAdapter.kind)) {
      credentials = await createAskpassCredentials(resolved.hostConfig.password);
    }
    const bridgePasswordEnv = useBuiltinSsh
      ? {}
      : await bridgeMasterPasswordEnv(context, resolved.hostConfig);
    // Probe the installed OpenSSH first so the legacy algorithm flags in the
    // plan match what this client understands (macOS/Linux ship a wide range
    // of OpenSSH versions, and old or new clients reject the fixed flags).
    if (!useBuiltinSsh) await warmSshCliCapabilities();
    // 主机密钥校验：系统 ssh 路径无法弹 VS Code 对话框，由扩展在
    // 连接前 ssh-keyscan 探测当前后端密钥并与扩展 known_hosts 文件比对（仅 prompt 模式；
    // accept 走 known_hosts 空设备静默接受，reject 走系统 ssh 严格校验）。
    let hostKeyPolicy = settings().get<'accept' | 'prompt' | 'reject'>(
      'hostKeyChangedAction', 'prompt'
    );
    if (!useBuiltinSsh && hostKeyPolicy === 'prompt') {
      const verification = await verifySystemSshHostKey(
        hostKeyPolicy, resolved.hostConfig, platformAdapter.kind,
        (message) => bridgeOutput?.appendLine(`[主机密钥] ${message}`),
        undefined, undefined,
        { WSL_VPN_SSH_CONFIG: configPath() }
      );
      if (!verification.ok) {
        void vscode.window.showErrorMessage(verification.reason!);
        return undefined;
      }
    }
    const plan = platformAdapter.terminal(resolved.hostConfig, remoteCwd, {
      reuseSshConnection: settings().get<boolean>('reuseSshConnection', true),
      bridgeMasterPassword: bridgePasswordEnv.WSL_VPN_MASTER_PASSWORD,
      bridgeConfigPath: configPath(),
      hostKeyPolicy,
      ...(hostKeyPolicy === 'prompt' ? { userKnownHostsFile: knownHostsFilePath() } : {})
    });
    const resolvedTerminalCommand = await resolveExecutable(plan.command, plan.env);
    const diagnostic = useBuiltinSsh
      ? undefined
      : await createTerminalDiagnostic(
          context, mount.name,
          redactSensitiveText(planDisplayName({ ...plan, command: resolvedTerminalCommand }))
        );
    const terminalPlan = diagnostic
      ? terminalDiagnosticPlan(
          platformAdapter.kind, resolvedTerminalCommand, plan, diagnostic.file
        )
      : { ...plan, command: resolvedTerminalCommand };
    const terminalCommand = await resolveExecutable(terminalPlan.command, terminalPlan.env);
    bridgeOutput?.appendLine(
      `[终端] 正在启动 ${mount.name}；cwd=${remoteCwd ?? remoteRoot}；$ ${
        redactSensitiveText(planDisplayName({ ...plan, command: resolvedTerminalCommand }))
      }`
    );
    const terminalStartedAt = performance.now();
    let builtinPty: import('./ssh2-terminal').Ssh2Terminal | undefined;
    const terminal = useBuiltinSsh
      ? (() => {
        let created!: vscode.Terminal;
        const pty = new Ssh2Terminal(
          resolved.hostConfig, resolved.hostConfig.password!, remoteCwd,
          (error) => {
            bridgeOutput?.appendLine(
              `[终端] 内置 ssh2 终端 ${mount.name} 失败：${error.stack ?? error.message}`
            );
            // Server rejected the pty/shell negotiation (gateway appliance):
            // mark this terminal for a system-ssh retry instead of the
            // built-in ssh2 transport.
            if (builtinSshFallbackPattern.test(error.message)) {
              const entry = managedRemoteTerminals.get(created);
              if (entry) entry.retryWithSystemSsh = true;
            }
          },
          (message) => bridgeOutput?.appendLine(`[主机密钥] ${message}`)
        );
        created = vscode.window.createTerminal({
          name: terminalName,
          pty,
          isTransient: true
        });
        builtinPty = pty;
        return created;
      })()
      : vscode.window.createTerminal({
        name: terminalName,
        shellPath: terminalCommand,
        shellArgs: terminalPlan.args,
        env: {
          SSH_BRIDGE_MOUNT_NAME: mount.name,
          [terminalIdentityEnv]: terminalId,
          // 主口令已通过 plan.env（WslAdapter 按 bridgeMasterPassword 注入）交给
          // ssh-bridge；这里不再重复注入，避免交互式终端环境里可被读取。
          ...terminalPlan.env,
          ...credentials?.env
        },
        cwd: os.homedir(),
        isTransient: true
      });
    performanceLine(`${mount.name} SSH 终端创建（不含远端握手）`, terminalStartedAt);
    managedRemoteTerminals.set(terminal, {
      mount, remoteCwd, pty: builtinPty, diagnostic, hostKeyRetries
    });
    if (credentials) {
      const disposable = vscode.window.onDidCloseTerminal((closed) => {
        if (closed === terminal) {
          disposable.dispose();
          void credentials?.cleanup();
        }
      });
      setTimeout(() => {
        disposable.dispose();
        void credentials?.cleanup();
      }, terminalCredentialTtlMs);
    }
    terminal.show();
    return { terminal, created: true };
  } finally {
    openingTerminalIds.delete(terminalId);
  }
}

// ---- disconnect / status ----

async function disconnect(requested?: MountConfig): Promise<void> {
  const mount = requested ?? await selectMount('选择要断开的 SFTP 连接');
  if (!mount) return;
  const current = currentRemoteLocation();
  if (current?.mountName === mount.name) {
    await vscode.commands.executeCommand('workbench.action.closeFolder');
  }
  registry.delete(mount.name);
  const config = await readConfig();
  const shared = registry.values().some((folder) => folder.hostName === mount.host);
  if (!shared) await pool.disconnect(resolveMount(config, mount).hostConfig.name);
  refreshSafsEntryLabel();

  // Keep the Agent-forwarding preference so reconnecting this mount can
  // restore Agent access through the stable MCP router.
  // Only the explicit toggle command clears the preference.
  await mcp?.stop();
  await agentWorkspacePublisher.remove();
}

// ---- Open Config ----

async function openConfig(hostName?: string): Promise<void> {
  const resolvedPath = await ensureConfigFile(configPath());
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedPath));
  const editor = await vscode.window.showTextDocument(document);
  if (!hostName) return;
  const offset = passwordValueOffset(document.getText(), hostName);
  if (offset === undefined) return;
  const position = document.positionAt(offset);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
}

// ---- Add SSH Config ----

interface InputOptions {
  title: string;
  prompt: string;
  value?: string;
  placeHolder?: string;
  password?: boolean;
  validateInput?: (value: string) => string | undefined;
}

async function input(options: InputOptions): Promise<string | undefined> {
  return vscode.window.showInputBox({
    ...options,
    ignoreFocusOut: true,
    valueSelection: options.value ? [0, options.value.length] : undefined
  });
}

const required = (label: string) => (value: string): string | undefined =>
  value.trim() ? undefined : `${label}不能为空`;

async function addSshConfig(context: vscode.ExtensionContext): Promise<void> {
  const title = 'Add SSH Config';
  const name = await input({
    title, prompt: '配置名称', value: 'dev', validateInput: required('配置名称')
  });
  if (name === undefined) return;
  const loginText = await input({
    title,
    prompt: 'SSH 登录地址',
    value: `${os.userInfo().username}@10.0.0.1`,
    placeHolder: 'user@10.0.0.1',
    validateInput: (value) => parseSshLogin(value) ? undefined : '请输入 user@IP 或 user@主机名'
  });
  if (loginText === undefined) return;
  const login = parseSshLogin(loginText);
  if (!login) throw new Error('SSH 登录地址格式无效');
  const password = await input({
    title,
    prompt: 'SSH 密码（留空则改用私钥）',
    placeHolder: '输入密码，或留空后按 Enter',
    password: true
  });
  if (password === undefined) return;
  const encryptedPassword = password
    ? await encryptPassword(password, await promptMasterPassword(context, true))
    : undefined;
  let privateKeyPath: string | undefined;
  if (!password) {
    privateKeyPath = await input({
      title,
      prompt: 'SSH 私钥路径',
      value: '~/.ssh/id_ed25519',
      placeHolder: '例如 ~/.ssh/id_ed25519',
      validateInput: required('私钥路径')
    });
    if (privateKeyPath === undefined) return;
  }
  let vpn = false;
  if (platformAdapter.kind === 'wsl') {
    const selectedVpn = await vscode.window.showQuickPick([
      {
        label: 'No',
        description: 'false（默认）：不使用外部 VPN 中继',
        value: false
      },
      {
        label: 'Yes',
        description: 'true：使用 aTrust 等外部 VPN 时启用中继',
        value: true
      }
    ], {
      title,
      placeHolder: '是否使用外部 VPN（如 aTrust）？',
      ignoreFocusOut: true
    });
    if (!selectedVpn) return;
    vpn = selectedVpn.value;
  }

  await ensureConfigFile(configPath());
  const config = await loadConfig(configPath());
  const normalizedName = name.trim();
  const existingIndex = config.hosts.findIndex((host) => host.name === normalizedName);
  if (existingIndex >= 0
    && await vscode.window.showWarningMessage(
      `配置"${normalizedName}"已存在，是否覆盖？`, { modal: true }, '覆盖'
    ) !== '覆盖') return;

  const host: HostConfig = {
    name: normalizedName,
    ip: login.host,
    user: login.user,
    port: 22
  };
  if (platformAdapter.kind === 'wsl') host.vpn = vpn;
  if (privateKeyPath) host.private_key_path = privateKeyPath.trim();
  if (encryptedPassword) host.password = encryptedPassword;
  if (existingIndex >= 0) config.hosts[existingIndex] = host;
  else config.hosts.push(host);

  config.mounts = deriveMounts(config.hosts);
  config.encrypt_passwords = true;
  await saveConfig(configPath(), config);
  void vscode.window.showInformationMessage(`已保存 SFTP 配置"${normalizedName}"`);
}

// ---- MCP / Remote Ops ----

async function mountAndFolder(mountName: string): Promise<{
  mount: MountConfig;
  folder: RemoteFolder;
}> {
  const config = await readConfig();
  const mount = config.mounts.find((candidate) => candidate.name === mountName);
      if (!mount) throw new Error(`远程目录不存在：${mountName}`);
  return { mount, folder: await ensureFolder(mount) };
}

async function forwardedMountName(requested?: string): Promise<string> {
  const enabled = new Set(vscodeContext.globalState.get<string[]>(aiForwardMountsKey, []));
  if (requested) {
    if (!enabled.has(requested)) throw new Error(`Agent 转发未开启：${requested}`);
    return requested;
  }
  const current = currentRemoteLocation()?.mountName;
  if (current && enabled.has(current)) return current;
  if (enabled.size === 1) return [...enabled][0];
  if (enabled.size === 0) throw new Error('Agent 转发未开启');
  throw new Error('有多个 Agent 转发目标，请提供 mountName');
}

function windowBoundMountName(boundMountName: string, requested?: string): string {
  if (requested && requested !== boundMountName) {
    throw new Error(
      `MCP 服务已绑定远程窗口“${boundMountName}”，不能访问“${requested}”`
    );
  }
  return boundMountName;
}

function forwardedWindowMountName(
  context: vscode.ExtensionContext, boundMountName: string, requested?: string
): string {
  const enabled = new Set(context.globalState.get<string[]>(aiForwardMountsKey, []));
  if (!enabled.has(boundMountName)) throw new Error(`Agent 转发未开启：${boundMountName}`);
  return windowBoundMountName(boundMountName, requested);
}

function toolPath(folder: RemoteFolder, value = '.'): string {
  // Relative tool paths resolve against the current remote directory
  // (kept in sync by SAFS: 切换远程目录), while still being validated
  // against the mount root.
  const base = currentWorkspacePath(folder);
  const resolved = value.startsWith('/')
    ? path.posix.normalize(value)
    : path.posix.resolve(base, value);
  if (!isRemotePathInsideRoot(folder.remoteRoot, resolved)) {
    throw new Error(`路径超出远程工作区：${value}`);
  }
  return resolved;
}

/** The remote directory currently open in this window, or the mount root. */
function currentWorkspacePath(folder: RemoteFolder): string {
  const location = currentRemoteLocation();
  if (location && location.mountName === folder.mountName) {
    return location.remotePath;
  }
  return folder.remoteRoot;
}

/**
 * 解析远程路径：相对路径基于当前 VS Code 工作区目录，而不是配置的挂载根。
 * 绝对路径仍可访问挂载外的位置，用于只读工具（list/search）查看
 * ~/.bashrc、/etc/hosts 等明确指定的路径。
 */
function resolveRemotePath(folder: RemoteFolder, value = '.'): string {
  return value.startsWith('/')
    ? path.posix.normalize(value)
    : path.posix.resolve(currentWorkspacePath(folder), value);
}

async function remoteList(input: {
  mountName: string; path?: string; limit?: number;
}): Promise<unknown> {
  const { folder } = await mountAndFolder(input.mountName);
  const remotePath = resolveRemotePath(folder, input.path);
  const entries = await (await pool.get(folder.hostName)).readDirectory(remotePath);
  // 默认 500 条上限：node_modules/dist 等巨型目录的完整列表对 Agent 是纯噪音，
  // 超限时返回 truncated + total 让 Agent 知道还有更多。
  const limit = Math.min(input.limit ?? 500, 10000);
  const truncated = entries.length > limit;
  return {
    path: remotePath,
    entries: entries.slice(0, limit).map(({ name, type }) => ({ name, type })),
    ...(truncated ? { truncated, total: entries.length } : {})
  };
}

async function remoteWrite(input: {
  mountName: string; path: string; content: string;
}): Promise<unknown> {
  const { folder } = await mountAndFolder(input.mountName);
  const workspaceRoot = currentWorkspacePath(folder);
  const remotePath = input.path.startsWith('/')
    ? path.posix.normalize(input.path)
    : path.posix.resolve(workspaceRoot, input.path);
  if (!isRemotePathInsideRoot(workspaceRoot, remotePath)) {
    throw new Error(`写入路径超出当前工作区：${input.path}`);
  }
  const session = await pool.get(folder.hostName);
  let securedPath: string;
  try {
    securedPath = await session.realpath(remotePath);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== 2 && code !== 'ENOENT') throw error;
    const parent = await session.realpath(path.posix.dirname(remotePath));
    securedPath = path.posix.join(parent, path.posix.basename(remotePath));
  }
  if (!isRemotePathInsideRoot(workspaceRoot, securedPath)) {
    throw new Error(`写入路径通过符号链接超出当前工作区：${input.path}`);
  }
  const uri = vscode.Uri.parse(folderUri(folder, remotePath));
  const content = new TextEncoder().encode(input.content);
  await provider.writeFile(uri, content, { create: true, overwrite: true });
  return { path: remotePath, bytes: content.length };
}

async function executeRemoteCommand(
  context: vscode.ExtensionContext,
  input: {
    command: string; mountName: string; remoteCwd?: string; source?: string; agentName?: string;
    agentPlatform?: string;
  },
  token?: vscode.CancellationToken
): Promise<Record<string, unknown>> {
  if (!input.command?.trim()) throw new Error('Remote command must not be empty.');
  const { mount, folder } = await mountAndFolder(input.mountName);
  const requestedCwd = toolPath(folder, input.remoteCwd);
  const remoteCwd = await (await pool.get(mount.host)).realpath(requestedCwd);
  if (!isRemotePathInsideRoot(folder.remoteRoot, remoteCwd)) {
    throw new Error(`远程工作目录通过符号链接超出工作区：${requestedCwd}`);
  }
  // 命令输出上限：Agent 上下文 token 保护。超限截断并标记 truncated: true，
  // 避免单次 head/cat/grep 把几十万 token 灌进会话。
  const maxOutputBytes = Math.max(
    4096,
    Math.min(1024 * 1024, settings().get<number>('agentMcpMaxOutputBytes', 64 * 1024))
  );
  const source = input.source ?? 'mcp';
  const logFailure = (error: unknown): void => {
    bridgeOutput?.appendLine(
      `[MCP 命令日志] 写入失败：${error instanceof Error ? error.message : String(error)}`
    );
  };
  const policy = evaluateMcpCommandPolicy(
    input.command, source, readMcpCommandPolicySettings(settings())
  );
  appendMcpCommandLog({
    source: policy.auditSource,
    agentName: input.agentName,
    agentPlatform: input.agentPlatform,
    mountName: mount.name,
    remoteCwd,
    command: input.command
  }).catch(logFailure);
  if (!policy.allowed) {
    bridgeOutput?.appendLine(
      `[高危指令拦截] 拒绝执行：${policy.redactedCommand}（规则：${policy.matched}）`
    );
    throw new Error(
      `高危指令已被 SAFS 拦截（规则：${policy.matched}）：${policy.redactedCommand}`
    );
  }
  if (policy.matched) {
    bridgeOutput?.appendLine(
      `[高危指令放行] 已按配置执行：${policy.redactedCommand}（规则：${policy.matched}）`
    );
  }
  const resolved = resolveMount(await readConfig(), mount);
  let credentials: AskpassCredentials | undefined;
  try {
    if (resolved.hostConfig.password) {
      const config = await readConfig();
      resolved.hostConfig = await resolveStoredHostPassword(context, config, resolved.hostConfig);
      if (platformAdapter.kind !== 'windows' && platformUsesAskpass(platformAdapter.kind)) {
        credentials = await createAskpassCredentials(resolved.hostConfig.password!);
      }
    }
    const controller = new AbortController();
    const cancellation = token?.onCancellationRequested(() => controller.abort());
    // 命令级超时：Agent 挂起时中止远端执行，避免命令在后台无限运行。
    // 与路由器的 forwardTimeoutMs 同源（safs.agentMcpTimeoutMs），保持一致。
    const commandTimeoutMs = settings().get<number>('agentMcpTimeoutMs', 120_000);
    let timedOut = false;
    const timeout = commandTimeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, commandTimeoutMs)
      : undefined;
    try {
      let result;
      if (platformAdapter.kind === 'windows') {
        bridgeOutput?.appendLine(
          `[${new Date().toLocaleString()}] [Agent MCP] $ ${redactSensitiveText(input.command)} (cwd: ${remoteCwd})`
        );
        try {
          result = await executeSsh2Command(
            resolved.hostConfig, resolved.hostConfig.password,
            remoteCwd, input.command, controller.signal, maxOutputBytes
          );
          bridgeOutput?.appendLine(
            `[Agent MCP] [${result.exitCode === 0 ? '完成' : `失败: exit ${result.exitCode}`}] ${redactSensitiveText(input.command)}`
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          bridgeOutput?.appendLine(`[Agent MCP] [失败] ${redactSensitiveText(input.command)}: ${detail}`);
          throw error;
        }
      } else {
        await warmSshCliCapabilities();
        const hostKeyPolicy = settings().get<'accept' | 'prompt' | 'reject'>(
          'hostKeyChangedAction', 'prompt'
        );
        const verifyCurrentSystemSshHostKey = async (): Promise<void> => {
          const verification = await verifySystemSshHostKey(
            hostKeyPolicy, resolved.hostConfig, platformAdapter.kind,
            (message) => bridgeOutput?.appendLine(`[主机密钥] ${message}`),
            undefined, undefined,
            { WSL_VPN_SSH_CONFIG: configPath() }
          );
          if (!verification.ok) throw new Error(verification.reason);
        };
        if (hostKeyPolicy === 'prompt') {
          await verifyCurrentSystemSshHostKey();
        }
        const plan = platformAdapter.exec(resolved.hostConfig, remoteCwd, input.command, {
          reuseSshConnection: settings().get<boolean>('reuseSshConnection', true),
          bridgeConfigPath: configPath(),
          hostKeyPolicy,
          ...(hostKeyPolicy === 'prompt' ? { userKnownHostsFile: knownHostsFilePath() } : {})
        });
        plan.env = {
          ...plan.env,
          ...await bridgeMasterPasswordEnv(context, resolved.hostConfig),
          ...credentials?.env
        };
        const runSystemSsh = () => executeAgentMcpCommand(
          plan, controller.signal, maxOutputBytes
        );
        result = hostKeyPolicy === 'prompt'
          ? await runWithOpenSshHostKeyRetry(
              runSystemSsh, verifyCurrentSystemSshHostKey,
              (message) => bridgeOutput?.appendLine(`[主机密钥] ${message}`)
            )
          : await runSystemSsh();
      }
      if (timedOut) {
        throw new Error(`远程命令执行超时（${commandTimeoutMs}ms）`);
      }
      return {
        remoteCwd,
        ...result
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      cancellation?.dispose();
    }
  } finally {
    await credentials?.cleanup();
  }
}

async function runRemote(input: {
  mountName: string; command: string; remoteCwd?: string; source?: string; agentName?: string;
  agentPlatform?: string;
}): Promise<unknown> {
  return executeRemoteCommand(vscodeContext, { ...input, source: input.source ?? 'mcp' });
}

async function remoteSearch(input: {
  mountName: string; query: string; path?: string; agentName?: string; agentPlatform?: string;
}): Promise<unknown> {
  const { folder } = await mountAndFolder(input.mountName);
  const requestedPath = resolveRemotePath(folder, input.path);
  const searchPath = await (await pool.get(folder.hostName)).realpath(requestedPath);
  // 依赖/构建/缓存目录（按目录名在任意层级匹配）一律跳过，避免搜索命中整库噪音；
  // 结果上限：最多 200 行、每行 300 字符，另有 agentMcpMaxOutputBytes 兜底。
  const excludeDirs = [
    '.git', 'node_modules', 'dist', 'build', 'out', 'target',
    '.venv', 'venv', '__pycache__', '.next', '.cache', 'coverage',
    'vendor', '.tox', 'site-packages', 'bower_components', 'Pods', '.gradle'
  ].map((dir) => `--exclude-dir=${dir}`).join(' ');
  const result = await executeRemoteCommand(vscodeContext, {
    mountName: input.mountName,
    remoteCwd: currentWorkspacePath(folder),
    source: 'remote_search',
    agentName: input.agentName,
    agentPlatform: input.agentPlatform,
    command: `grep -rIn ${excludeDirs} -- ${shellQuote(input.query)} ${
      shellQuote(searchPath)
    } | cut -c 1-300 | head -n 200`
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  return {
    ...result,
    // grep 无匹配时经 cut/head 管道的最终状态已是 0；显式返回
    // matchCount 让 Agent 无需根据空 stdout 或进程退出码猜测语义。
    matchCount: stdout ? stdout.replace(/\n$/, '').split('\n').length : 0
  };
}

// ---- Tree View ----

interface HistoryItem {
  type: 'history';
  mountName: string;
  path: string;
}

type TreeElement = MountConfig | HistoryItem;

const MAX_HISTORY_ENTRIES = 10;

async function getDirectoryHistory(
  context: vscode.ExtensionContext
): Promise<Record<string, string[]>> {
  return context.globalState.get<Record<string, string[]>>(
    directoryHistoryKey, {}
  );
}

async function recordDirectoryHistory(
  context: vscode.ExtensionContext,
  mountName: string,
  remotePath: string
): Promise<void> {
  const history = await getDirectoryHistory(context);
  const entries = history[mountName] ?? [];
  const idx = entries.indexOf(remotePath);
  if (idx >= 0) {
    entries.splice(idx, 1);
  }
  entries.unshift(remotePath);
  if (entries.length > MAX_HISTORY_ENTRIES) {
    entries.length = MAX_HISTORY_ENTRIES;
  }
  history[mountName] = entries;
  await context.globalState.update(directoryHistoryKey, history);
}

async function removeHistoryEntry(
  context: vscode.ExtensionContext,
  mountName: string,
  remotePath: string
): Promise<void> {
  const history = await getDirectoryHistory(context);
  const entries = history[mountName] ?? [];
  const idx = entries.indexOf(remotePath);
  if (idx >= 0) {
    entries.splice(idx, 1);
    history[mountName] = entries;
    await context.globalState.update(directoryHistoryKey, history);
  }
}

class RemoteFoldersProvider implements vscode.TreeDataProvider<TreeElement> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    if ('type' in element && element.type === 'history') {
      return this.getHistoryTreeItem(element);
    }
    return this.getMountTreeItem(element as MountConfig);
  }

  private getMountTreeItem(mount: MountConfig): vscode.TreeItem {
    const connectionState = pool.state(mount.host);
    const connected = registry.get(mount.name) !== undefined && connectionState === 'connected';
    const aiForwarded = this.context.globalState
      .get<string[]>(aiForwardMountsKey, []).includes(mount.name);
    const workspaces = discoverAgentWorkspaces();
    const forwarding = aiForwarded
      && workspaces.some((workspace) => workspace.mountName === mount.name);
    const focused = aiForwarded
      && workspaces.some((workspace) => workspace.mountName === mount.name && workspace.focused);
    const item = new vscode.TreeItem(mount.name);
    const connectionLabel = connected
      ? '已连接'
      : connectionState === 'connecting' || connectionState === 'reconnecting'
        ? '连接中'
        : connectionState === 'error' ? '连接错误' : '未连接';
    const symbol = focused ? '👁' : forwarding ? '⚡' : aiForwarded ? '○' : undefined;
    item.description = symbol ? `Agent State: ${symbol}` : undefined;
    item.contextValue = [
      'safs.connection',
      connected ? 'connected' : 'disconnected',
      aiForwarded ? 'aiEnabled' : 'aiDisabled'
    ].join('.');
    item.iconPath = new vscode.ThemeIcon(connected ? 'vm-active' : 'remote');
    item.tooltip = new vscode.MarkdownString([
      `**${mount.name}**`,
      '',
      `Host: \`${mount.host}\``,
      `Remote: \`${mount.remote_path}\``,
      '',
      `SFTP：${connectionLabel}`,
      forwarding
        ? 'Agent 转发：转发中'
        : aiForwarded
          ? 'Agent 转发：已启用（未转发）'
          : 'Agent 转发：已关闭',
      focused
        ? 'MCP 绑定：聚焦窗口（默认路由目标）'
        : forwarding
          ? 'MCP 绑定：其他窗口'
          : 'MCP 绑定：无',
      '',
      '展开可查看历史远程目录。'
    ].join('\n'));
    item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    return item;
  }

  private getHistoryTreeItem(item: HistoryItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(item.path);
    const syncing = historySyncTask(item) !== undefined;
    treeItem.contextValue = `safs.history.${syncing ? 'syncEnabled' : 'syncDisabled'}`;
    treeItem.iconPath = new vscode.ThemeIcon('folder');
    treeItem.tooltip = `${item.path}`;
    treeItem.command = {
      command: 'safs.openHistoryItem',
      title: '打开历史目录',
      arguments: [item]
    };
    return treeItem;
  }

  async getChildren(element?: TreeElement): Promise<TreeElement[]> {
    if (element && 'type' in element && element.type === 'history') {
      return [];
    }
    if (element && !('type' in element)) {
      const history = await getDirectoryHistory(this.context);
      const entries = history[element.name] ?? [];
      return entries.map((path) => ({
        type: 'history' as const,
        mountName: element.name,
        path
      }));
    }
    try {
      const config = await readConfig();
      await vscode.commands.executeCommand(
        'setContext', 'safs.hasNoMounts', config.mounts.length === 0
      );
      return config.mounts;
    } catch {
      return [];
    }
  }

  getParent(element: TreeElement): TreeElement | undefined {
    if ('type' in element && element.type === 'history') {
      if (!lastReadConfig) return undefined;
      const mount = lastReadConfig.mounts.find((m) => m.name === element.mountName);
      return mount ?? undefined;
    }
    return undefined;
  }
}

// ---- Workspace restore ----

async function restoreRemoteWorkspaces(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders?.filter(
    (folder) => folder.uri.scheme === remoteFileSystemScheme
  ) ?? [];
  if (folders.length === 0) return;
  const config = await readConfig();
  for (const workspace of folders) {
    try {
      const location = parseRemoteUri(workspace.uri.toString());
      const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
      if (!mount) continue;
      const folder = await ensureFolder(mount);
      if (!isRemotePathInsideRoot(folder.workspaceRoot, location.remotePath)) {
        output.appendLine(
          `工作区使用不受支持的旧 URI，请从 SAFS 面板重新打开：${mount.name}`
        );
        continue;
      }
      const openedRemotePath = remotePathForUri(folder, location.remotePath);
      await writeLastRemoteDirectory(
        localRootForFolder(folder), folder.remoteRoot, openedRemotePath
      );
      if (folder.remoteRoot !== openedRemotePath) {
        output.appendLine(
          `远程根目录已变化：${openedRemotePath} -> ${folder.remoteRoot}`
        );
      }
      if (mount.remote_terminal === 'open') {
        // 标记：本次自动连接后，首次远程文件激活时无条件跟随其目录（标签页恢复）。
        restoredFileSyncPending.add(mount.name);
        await openTerminal(vscodeContext, mount, openedRemotePath);
        // 非阻塞补检，覆盖“文件先激活、终端后创建/事件先于监听器注册”的时序。
        deferRestoreFollow(mount.name);
      }
    } catch (error) {
      // 单个挂载恢复失败（口令取消、连接异常）不阻断其余挂载的恢复。
      const detail = error instanceof Error ? error.message : String(error);
      bridgeOutput?.appendLine(`[工作区恢复] ${workspace.uri.toString()}: ${detail}`);
    }
  }
}

/**
 * 同步镜像以 file:// 工作区打开，不会进入 restoreRemoteWorkspaces。
 * 根据持久化同步任务把本地根映射回远程 cwd，恢复与远程工作区一致的自动终端。
 */
async function restoreSyncedLocalWorkspaceTerminal(): Promise<void> {
  const localRoots = (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => path.resolve(folder.uri.fsPath));
  if (localRoots.length === 0 || !syncManager) return;
  const task = syncManager.list().find((candidate) =>
    localRoots.includes(path.resolve(candidate.localDir))
  );
  if (!task || !await syncCoordinator?.isReady(
    task.mountName, task.remotePath, task.localDir
  )) return;
  const config = await readConfig();
  const mount = config.mounts.find((candidate) => candidate.name === task.mountName);
  if (!mount || mount.remote_terminal !== 'open') return;
  await openTerminal(vscodeContext, mount, task.remotePath);
}

async function preloadRemoteWorkspaces(): Promise<void> {
  const workspaces = vscode.workspace.workspaceFolders?.filter(
    (folder) => folder.uri.scheme === remoteFileSystemScheme
  ) ?? [];
  if (workspaces.length === 0) return;
  const config = await readConfig();
  for (const workspace of workspaces) {
    try {
      const location = parseRemoteUri(workspace.uri.toString());
      const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
      if (!mount) continue;
      await ensureFolder(mount);
    } catch (error) {
      // A broken/stale workspace folder must not block the rest of the
      // window or pop an error dialog on every startup.
      const detail = error instanceof Error ? error.message : String(error);
      bridgeOutput?.appendLine(`[工作区预载] ${workspace.uri.toString()}: ${detail}`);
    }
  }
}

// ---- Status ----

async function showStatus(): Promise<void> {
  const config = await readConfig();
  output.clear();
  for (const mount of config.mounts) {
    const folder = registry.get(mount.name);
    const state = pool.state(mount.host);
    output.appendLine(
      `${mount.name}: ${state}; host=${mount.host}; remote=${
        folder?.remoteRoot ?? mount.remote_path
      }${pool.error(mount.host) ? `; error=${pool.error(mount.host)?.message}` : ''}`
    );
  }
  output.show(true);
}

// ---- Delete Config ----

async function deleteConfig(mount: MountConfig): Promise<void> {
  const connected = registry.get(mount.name) !== undefined;
  const confirmMessage = connected
    ? `"${mount.name}" 的 SFTP 连接已连接，删除配置需先断开连接。是否断开并删除该配置？`
    : `确定删除"${mount.name}"配置吗？`;
  const confirmButton = connected ? '断开并删除' : '删除';
  if (await vscode.window.showWarningMessage(
    confirmMessage, { modal: true }, confirmButton
  ) !== confirmButton) return;
  if (connected) await disconnect(mount);
  const config = await readConfig();
  removeMountConfig(config, mount.name);
  await saveConfig(configPath(), config);
  const enabled = new Set(
    vscodeContext.globalState.get<string[]>(aiForwardMountsKey, [])
  );
  if (enabled.delete(mount.name)) {
    await vscodeContext.globalState.update(aiForwardMountsKey, [...enabled]);
  }
}

// ---- AI Agent Forwarding (aligned with main) ----

async function forwardedFolders(context: vscode.ExtensionContext): Promise<import('./agent-mcp').RemoteFolderInfo[]> {
  const config = await readConfig();
  const enabled = new Set(context.globalState.get<string[]>(aiForwardMountsKey, []));
  const current = currentRemoteLocation();
  return Promise.all(config.mounts
    .filter((mount) => enabled.has(mount.name))
    .map(async (mount) => {
      const folder = await ensureFolder(mount);
      const workspacePath = current?.mountName === mount.name
        ? currentWorkspacePath(folder)
        : folder.remoteRoot;
      return {
        name: mount.name,
        workspaceUri: folderUri(folder, workspacePath),
        workspaceRoot: workspacePath,
        host: mount.host
      };
    })
  );
}

async function agentMcpToken(context: vscode.ExtensionContext): Promise<string> {
  let token = await context.secrets.get(agentMcpTokenSecret);
  if (!token) {
    token = randomBytes(24).toString('hex');
    await context.secrets.store(agentMcpTokenSecret, token);
  }
  return token;
}

function auditMcpTool(entry: {
  toolName: string; input: Record<string, unknown>;
  agentName?: string; agentPlatform?: string;
}): void {
  void appendMcpToolLog(entry).catch((error) => {
    bridgeOutput?.appendLine(
      `[MCP 工具日志] 写入失败：${error instanceof Error ? error.message : String(error)}`
    );
  });
}

async function ensureAgentHttpRouter(
  context: vscode.ExtensionContext
): Promise<AgentHttpRouter> {
  let router = httpRouter;
  if (!router) {
    if (!httpRouterCreation) {
      httpRouterCreation = (async () => {
        const router = new AgentHttpRouter(
          settings().get<number>('agentHttpRouterPort', 9848),
          await agentMcpToken(context),
          {
            log: (message) => bridgeOutput?.appendLine(`[Agent HTTP Router] ${message}`),
            audit: auditMcpTool,
            forwardTimeoutMs: settings().get<number>('agentMcpTimeoutMs', 120_000)
          }
        );
        httpRouter = router;
        context.subscriptions.push({ dispose: () => void router.stop() });
        return router;
      })().finally(() => {
        httpRouterCreation = undefined;
      });
    }
    router = await httpRouterCreation;
  }
  if (!httpRouterStart) {
    httpRouterStart = router.start().then(() => router).finally(() => {
      httpRouterStart = undefined;
    });
  }
  return httpRouterStart;
}

function startAgentHttpRouterLeadership(context: vscode.ExtensionContext): void {
  if (agentHttpRouterHeartbeat) return;
  // 相同错误只记录一次，避免非 leader 窗口每 ~4.5s 刷屏（端口被无关程序占用时）。
  let lastLog = '';
  const logOnce = (message: string) => {
    if (lastLog === message) return;
    lastLog = message;
    bridgeOutput?.appendLine(`[Agent HTTP Router] ${message}`);
  };
  const retry = () => void ensureAgentHttpRouter(context).catch((error) => {
    logOnce(error instanceof Error ? error.message : String(error));
  });
  retry();
  agentHttpRouterHeartbeat = setInterval(retry, 4_000 + Math.floor(Math.random() * 1_000));
  context.subscriptions.push({
    dispose: () => {
      if (agentHttpRouterHeartbeat) clearInterval(agentHttpRouterHeartbeat);
      agentHttpRouterHeartbeat = undefined;
    }
  });
}

async function stopAgentHttpRouterLeadership(): Promise<void> {
  if (agentHttpRouterHeartbeat) clearInterval(agentHttpRouterHeartbeat);
  agentHttpRouterHeartbeat = undefined;
  await httpRouterStart?.catch(() => undefined);
  await httpRouter?.stop();
}

async function ensureAgentMcpServer(context: vscode.ExtensionContext): Promise<AgentMcpServer> {
  if (!mcp) {
    const token = await agentMcpToken(context);
    const location = currentRemoteLocation();
    if (!location) throw new Error('当前窗口不是 Serverless Remote 工作区');
    const boundMountName = location.mountName;
    agentTrace('MCP', `创建窗口级 MCP，绑定挂载 ${boundMountName}`);
    mcp = new AgentMcpServer(
      settings().get<number>('agentMcpPort', 0),
      token,
      {
        listFolders: async () => (await forwardedFolders(context)).filter(
          (folder) => folder.name === boundMountName
        ),
        currentWorkspace: async () => {
          const location = currentRemoteLocation();
          if (!location) return null;
          const enabled = new Set(context.globalState.get<string[]>(aiForwardMountsKey, []));
          if (!enabled.has(location.mountName)) return null;
          const config = await readConfig();
          const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
          if (!mount) return null;
          const folder = await ensureFolder(mount);
          const workspacePath = currentWorkspacePath(folder);
          return {
            name: mount.name,
            workspaceUri: folderUri(folder, workspacePath),
            workspaceRoot: workspacePath,
            host: mount.host
          };
        },
        currentFile: (input) => activeRemoteFile(input.mountName),
        list: async (input) => remoteList({
          ...input, mountName: forwardedWindowMountName(context, boundMountName, input.mountName)
        }),
        write: async (input) => remoteWrite({
          ...input, mountName: forwardedWindowMountName(context, boundMountName, input.mountName)
        }),
        search: async (input) => remoteSearch({
          ...input, mountName: forwardedWindowMountName(context, boundMountName, input.mountName)
        }),
        run: async (input) => executeRemoteCommand(context, {
          ...input, mountName: forwardedWindowMountName(context, boundMountName, input.mountName)
        }),
        request: (agentName, agentPlatform) => {
          updateSafsStatusBar(vscode.window.state.focused, agentName, agentPlatform);
        },
        audit: auditMcpTool,
        log: (message) => bridgeOutput?.appendLine(`[Agent MCP] ${message}`)
      }
    );
    context.subscriptions.push({ dispose: () => void mcp?.stop() });
  }
  agentTrace('MCP', `启动窗口级 MCP，configuredPort=${settings().get<number>('agentMcpPort', 0)}`);
  await mcp.start();
  agentTrace('MCP', mcp.portUnavailable
    ? 'MCP 启动失败：端口不可用'
    : `MCP 已运行，port=${new URL(mcp.url).port}`);
  return mcp;
}

async function publishAgentWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const location = currentRemoteLocation();
  const enabled = new Set(context.globalState.get<string[]>(aiForwardMountsKey, []));
  if (!location || !enabled.has(location.mountName) || !mcp?.running || mcp.portUnavailable) {
    updateSafsStatusBar(false, undefined, undefined, true);
    if (location && !enabled.has(location.mountName)) await mcp?.stop();
    await agentWorkspacePublisher.remove();
    const reason = !location ? '非远程工作区'
      : !enabled.has(location.mountName) ? `挂载 ${location.mountName} 未启用 Agent 转发`
        : !mcp?.running ? 'MCP 未运行' : 'MCP 端口不可用';
    if (lastAgentDiscoveryState !== `removed:${reason}`) {
      lastAgentDiscoveryState = `removed:${reason}`;
      agentTrace('Discovery', `未发布工作区记录：${reason}`);
    }
    return;
  }
  const config = await readConfig();
  const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
  if (!mount) {
    updateSafsStatusBar(false, undefined, undefined, true);
    await agentWorkspacePublisher.remove();
    return;
  }
  const folder = await ensureFolder(mount);
  const workspacePath = currentWorkspacePath(folder);
  await agentWorkspacePublisher.publish({
    focused: vscode.window.state.focused,
    execution: 'remote',
    workspaceUri: folderUri(folder, workspacePath),
    mountName: mount.name,
    workspaceRoot: workspacePath,
    agentCwd: vscode.Uri.parse(folderUri(folder, workspacePath)).fsPath,
    host: mount.host,
    mcpUrl: mcp.url
  });
  updateSafsStatusBar(vscode.window.state.focused);
  const state = `published:${mount.name}:${workspacePath}:${mcp.url}:${vscode.window.state.focused}`;
  if (lastAgentDiscoveryState !== state) {
    lastAgentDiscoveryState = state;
    agentTrace(
      'Discovery',
      `已发布挂载 ${mount.name}，focused=${vscode.window.state.focused}，port=${new URL(mcp.url).port}`
    );
  }
}

function startAgentWorkspacePublishing(context: vscode.ExtensionContext): void {
  if (agentWorkspaceHeartbeat) clearInterval(agentWorkspaceHeartbeat);
  const refresh = () => void publishAgentWorkspace(context).catch((error) => {
    bridgeOutput?.appendLine(`[Agent discovery] ${error instanceof Error ? error.message : String(error)}`);
  });
  refresh();
  agentWorkspaceHeartbeat = setInterval(refresh, 10_000);
  // 转发状态与聚焦窗口变化（本窗口或其他窗口启用/关闭/发布/聚焦切换）时刷新
  // 树视图，让“转发中/已启用”状态与“👁 聚焦窗口”指示符保持最新。
  const forwardingRefresh = () => {
    const workspaces = discoverAgentWorkspaces();
    const active = new Set(workspaces.map((workspace) => workspace.mountName));
    const focusedMount = workspaces.find((workspace) => workspace.focused)?.mountName ?? '';
    const signature = `${focusedMount}|${[...active].sort().join(',')}`;
    if (signature !== lastForwardingSignature) {
      lastForwardingSignature = signature;
      refreshTree();
    }
  };
  forwardingRefresh();
  const forwardingTimer = setInterval(forwardingRefresh, 10_000);
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) updateSafsStatusBar(false);
      refresh();
      if (state.focused) forwardingRefresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    {
      dispose: () => {
        if (agentWorkspaceHeartbeat) clearInterval(agentWorkspaceHeartbeat);
        agentWorkspaceHeartbeat = undefined;
        clearInterval(forwardingTimer);
      }
    },
    {
      dispose: () => {
        if (agentWorkspaceHeartbeat) clearInterval(agentWorkspaceHeartbeat);
        agentWorkspaceHeartbeat = undefined;
        void agentWorkspacePublisher.remove().catch((error) =>
          logAsyncFailure('Agent discovery 清理失败', error)
        );
      }
    }
  );
}

// ---- Agent 通用转发定义（配置项为 Agent CLI 名）----

// 类型与内置定义见 agent-mcp-registry.ts（AgentDefinition、builtinAgentDefinitions、
// genericAgentDefinition、resolveAgentDefinitions、agentSupportsMcpFor、runAgentMcpOperation）。

async function detectAgentCommand(
  def: AgentDefinition, platform: AgentPlatformContext, shouldRegister: boolean
): Promise<string | undefined> {
  // Pi / DSH 的 handler 虽然直接写配置文件，启用时仍必须检测到 Agent CLI，
  // 否则残留 home 目录会被误报为已安装。卸载时允许无 CLI 清理残留配置。
  const handlerFallback = handlerFallbackCommand(def, shouldRegister);
  if (handlerFallback) return handlerFallback;
  if (platform.wsl) {
    // Agent 在 WSL 中：CLI 从 WSL 的 PATH 解析；PATH 没有时再扫描 WSL 的
    // VS Code Server 扩展内置 CLI（Windows 端 getExtension 看不到 WSL 里
    // 安装的扩展）。
    if (await wslCommandExists(def.cliName)) return def.cliName;
    const bundled = await wslBundledCli(def, platform.home);
    if (bundled) {
      bridgeOutput?.appendLine(`[Agent MCP] 使用 WSL VS Code 扩展内置 CLI：${bundled}`);
      return bundled;
    }
    return undefined;
  }
  if (await commandExists(def.cliName)) return def.cliName;
  if (!def.extensionId || !def.bundledCandidates) return undefined;
  const extension = vscode.extensions.getExtension(def.extensionId);
  if (!extension) return undefined;
  for (const candidate of await def.bundledCandidates(extension.extensionPath)) {
    try {
      await access(candidate);
      bridgeOutput?.appendLine(`[Agent MCP] 使用 ${def.displayName} 扩展内置 CLI：${candidate}`);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/** 注册表操作的宿主执行器：CLI 走 executeAgentMcpCommand，日志走输出面板 */
function createMcpRunner(platform: AgentPlatformContext): AgentMcpCliRunner {
  return {
    run: (command, args, signal) => executeAgentMcpCommand(
      platform.wsl
        // 经 bash 激活用户交互环境（nvm 等 PATH）后执行，见 wslBashInvocation。
        ? wslBashInvocation('exec "$1" "${@:2}"', [command, ...args])
        : { command, args },
      signal
    ),
    log: (message) => bridgeOutput?.appendLine(
      `[${new Date().toLocaleString()}] [Agent MCP] $ ${message}`
    )
  };
}

async function configureDetectedAgents(
  context: vscode.ExtensionContext, shouldRegister: boolean
): Promise<AgentMcpSetupResult> {
  const router = shouldRegister ? await ensureAgentHttpRouter(context) : httpRouter;
  const routerUrl = router?.url;
  const saved = context.globalState.get<unknown>(agentSetupCompletedKey);
  const configured = new Set(Array.isArray(saved) ? saved.filter(
    (item): item is string => typeof item === 'string'
  ) : []);
  const forwardingAgents = settings().get<string[]>(
    'agentForwardingAgents', defaultForwardingAgents
  );
  const agentPlatform = await resolveAgentPlatform(
    settings().get<string>('agentPlatform', 'auto')
  );
  const platformLabel: AgentPlatformLabel = agentPlatform.wsl || platformAdapter.kind === 'wsl'
    ? 'wsl'
    : platformAdapter.kind === 'windows'
      ? 'win'
      : platformAdapter.kind === 'macos' ? 'mac' : 'linux';
  // 卸载路径的探测集合 = 当前设置 ∪ 曾成功配置的记录（`<cliName>:safs`），
  // 两者皆空时兜底内置默认集合——保证设置被清空/Agent 被移出列表后，
  // 残留的固定 MCP 仍能被探测并移除（而非静默跳过）。
  const agentNames = shouldRegister
    ? forwardingAgents
    : resolveUnloadAgentNames(forwardingAgents, [...configured]);
  const definitions = resolveAgentDefinitions(agentNames, {
    agentHome: agentPlatform.home
  });
  const mcpRunner = createMcpRunner(agentPlatform);
  bridgeOutput?.appendLine(
    `[Agent MCP] Agent 平台：${
      agentPlatform.wsl ? `WSL（home=${agentPlatform.home}）` : '与插件相同'
    }`
  );
  bridgeOutput?.appendLine(
    `[Agent MCP] 转发目标：${[...forwardingAgents].join(', ') || '<empty>'}`
  );
  if (!shouldRegister) {
    bridgeOutput?.appendLine(
      `[Agent MCP] 卸载探测集合：${agentNames.join(', ') || '<empty>'}`
    );
  }

  interface AgentState {
    def: AgentDefinition;
    mcpUrl?: string;
    command?: string;
    enabled: boolean;
    fixedExists: boolean;
    fixedConfigured: boolean;
    supportsMcp: boolean;
  }

  const states: AgentState[] = await Promise.all(definitions.map(async (def): Promise<AgentState> => {
    const mcpUrl = routerUrl
      ? agentTaggedMcpUrl(routerUrl, def.cliName, platformLabel)
      : undefined;
    const enabled = forwardingAgents.some(
      (name) => name === def.cliName || def.legacyIds?.includes(name)
    );
    const command = await detectAgentCommand(def, agentPlatform, shouldRegister);
    if (!command) {
      bridgeOutput?.appendLine(
        `[Agent MCP] Agent 检测：${def.displayName} 未找到 CLI${
          def.extensionId ? `（PATH 与 VS Code 扩展 ${def.extensionId} 均无）` : ''
        }`
      );
      return {
        def, mcpUrl, command: undefined, enabled,
        fixedExists: false, fixedConfigured: false, supportsMcp: true
      };
    }
    const prerequisiteMissing = def.mcp.handler?.prerequisiteCheck
      ? await def.mcp.handler.prerequisiteCheck()
      : undefined;
    if (prerequisiteMissing) {
      bridgeOutput?.appendLine(
        `[Agent MCP] ${def.displayName} 前置条件缺失，跳过自动注册：${prerequisiteMissing}`
      );
      return {
        def, mcpUrl, command, enabled,
        fixedExists: false, fixedConfigured: false, supportsMcp: true
      };
    }
    // 探测缓存：TTL 内复用同一 (cliName, routerUrl) 的结果；命中则跳过 spawn。
    const cacheKey = `${def.cliName}\0${mcpUrl ?? ''}`;
    const cached = agentProbeCache.get(cacheKey);
    const cachedStatus = cached && Date.now() - cached.at < agentProbeCacheTtlMs
      ? cached.status
      : undefined;
    if (!cachedStatus) {
      const signal = AbortSignal.timeout(agentProbeTimeoutMs);
      const status = await runAgentMcpOperation(
        def, command, 'get', undefined, mcpRunner, 'safs', signal
      );
      if (signal.aborted) {
        bridgeOutput?.appendLine(
          `[Agent MCP] ${def.displayName} 探测超时（${agentProbeTimeoutMs}ms），跳过自动注册。`
        );
        return {
          def, mcpUrl, command, enabled,
          fixedExists: false, fixedConfigured: false, supportsMcp: true
        };
      }
      agentProbeCache.set(cacheKey, { status, at: Date.now() });
      const output = `${status.stdout}\n${status.stderr}`;
      const fixedExists = status.exitCode === 0;
      const supportsMcp = agentSupportsMcpFor(def, status);
      const fixedConfigured = fixedExists && Boolean(mcpUrl && output.includes(mcpUrl));
      return { def, mcpUrl, command, enabled, fixedExists, fixedConfigured, supportsMcp };
    }
    const output = `${cachedStatus.stdout}\n${cachedStatus.stderr}`;
    const fixedExists = cachedStatus.exitCode === 0;
    const supportsMcp = agentSupportsMcpFor(def, cachedStatus);
    const fixedConfigured = fixedExists && Boolean(mcpUrl && output.includes(mcpUrl));
    return { def, mcpUrl, command, enabled, fixedExists, fixedConfigured, supportsMcp };
  }));

  const unsupportedMcp = states.filter((state) => state.command && !state.supportsMcp);
  for (const state of unsupportedMcp) {
    bridgeOutput?.appendLine(
      `[Agent MCP] ${state.def.displayName}（${state.command}）不支持 'mcp' 子命令，已跳过自动注册。`
    );
  }
  for (const state of states) {
    const statusText = !state.command ? '未找到 CLI'
      : !state.supportsMcp ? '不支持 MCP'
        : state.fixedConfigured ? '固定 HTTP MCP 已注册'
          : state.fixedExists ? '旧配置待迁移'
            : '固定 HTTP MCP 未注册';
    bridgeOutput?.appendLine(`[Agent MCP] 注册状态：${state.def.displayName} ${statusText}`);
  }
  if (!shouldRegister) {
    // 卸载路径：曾成功配置、但当前探测不到（如 CLI 已卸载）的 Agent 保留记录，
    // 避免静默漏删——CLI 恢复后下次卸载会重试。
    for (const state of states) {
      if (configured.has(`${state.def.cliName}:safs`) && !state.command) {
        bridgeOutput?.appendLine(
          `[Agent MCP] ${state.def.displayName} 曾注册过固定 MCP 但当前未找到 CLI，保留卸载记录，待 CLI 可用时重试。`
        );
      }
    }
  }
  if (shouldRegister && unsupportedMcp.length > 0) {
    vscode.window.showWarningMessage(
      `SAFS：以下 Agent CLI 不支持 MCP，已跳过自动注册：${
        unsupportedMcp.map((state) => state.def.displayName).join('、')
      }。详情见输出面板。`
    );
  }

  const needsSetup = states.filter(
    (state) => Boolean(
      state.command && shouldRegister && state.enabled && state.supportsMcp
      && !state.fixedConfigured
    )
  );
  const needsDisable = states.filter(
    (state) => Boolean(
      state.command && (!shouldRegister || !state.enabled) && state.fixedExists
    )
  );
  const registeredAgents = new Set(
    states
      .filter((state) => shouldRegister && state.enabled && state.fixedConfigured)
      .map((state) => state.def.displayName)
  );
  // 启用路径：清理不再匹配的记录（Agent 未启用或已不是当前 URL）；
  // 卸载路径不在此处删除记录——删除只发生在 remove 成功之后，保证
  // 探测不到的 Agent 记录保留、下次可重试。
  if (shouldRegister) {
    for (const state of states) {
      const key = `${state.def.cliName}:safs`;
      if (!state.enabled || !state.fixedConfigured) configured.delete(key);
    }
  }
  if (needsSetup.length === 0 && needsDisable.length === 0) {
    await context.globalState.update(agentSetupCompletedKey, [...configured]);
    return { succeeded: true, registeredAgents: [...registeredAgents] };
  }
  bridgeOutput?.appendLine([
    shouldRegister
      ? '[Agent MCP] Agent 转发已启用，开始自动配置统一 MCP。'
      : '[Agent MCP] 已无启用 Agent 转发的挂载，移除统一 MCP。',
    needsSetup.length > 0
      ? `配置 ${needsSetup.map((state) => state.def.displayName).join(' 和 ')}。`
      : '',
    ...needsDisable.map((state) => `移除未启用的 ${state.def.displayName} MCP。`),
    routerUrl ? `router=${redactAgentMcpText(routerUrl)}` : ''
  ].filter(Boolean).join(' '));
  const failures: string[] = [];
  for (const state of needsDisable) {
    const signal = AbortSignal.timeout(agentProbeTimeoutMs);
    const result = await runAgentMcpOperation(
      state.def, state.command!, 'remove', undefined, mcpRunner, 'safs', signal
    );
    if (signal.aborted) {
      failures.push(`${state.def.displayName} MCP remove 超时`);
    } else if (result.exitCode === 0) {
      configured.delete(`${state.def.cliName}:safs`);
      agentProbeCache.set(`${state.def.cliName}\0${state.mcpUrl ?? ''}`, {
        status: { exitCode: 1, stdout: '', stderr: '', truncated: false }, at: Date.now()
      });
      bridgeOutput?.appendLine(
        `[Agent MCP] ${state.def.displayName} 未被设置启用，已移除其 MCP 转发入口`
      );
    } else {
      failures.push(`${state.def.displayName} MCP remove: ${result.stderr || result.stdout}`);
    }
  }
  for (const state of needsSetup) {
    let canAdd = true;
    if (state.fixedExists) {
      const removed = await runAgentMcpOperation(
        state.def, state.command!, 'remove', undefined, mcpRunner, 'safs',
        AbortSignal.timeout(agentProbeTimeoutMs)
      );
      if (removed.exitCode !== 0) {
        canAdd = false;
        failures.push(
          `${state.def.displayName} MCP migration remove: ${removed.stderr || removed.stdout}`
        );
      }
    }
    if (canAdd) {
      const signal = AbortSignal.timeout(agentProbeTimeoutMs);
      const result = await runAgentMcpOperation(
        state.def, state.command!, 'add', state.mcpUrl!, mcpRunner, 'safs', signal
      );
      if (signal.aborted) {
        failures.push(`${state.def.displayName}: MCP add 超时`);
      } else if (result.exitCode !== 0 && !/already exists/i.test(`${result.stdout}\n${result.stderr}`)) {
        failures.push(`${state.def.displayName}: ${result.stderr || result.stdout}`);
      } else {
        configured.add(`${state.def.cliName}:safs`);
        // 注册成功后更新探测缓存，后续 configure 不再重复探测/重复 add。
        agentProbeCache.set(`${state.def.cliName}\0${state.mcpUrl ?? ''}`, {
          status: { exitCode: 0, stdout: state.mcpUrl ?? '', stderr: '', truncated: false },
          at: Date.now()
        });
        bridgeOutput?.appendLine(
          `[Agent MCP] ${state.def.displayName} 固定 HTTP MCP 路由注册成功`
        );
        registeredAgents.add(state.def.displayName);
      }
    }
  }
  await context.globalState.update(agentSetupCompletedKey, [...configured]);
  if (failures.length > 0) {
    bridgeOutput?.appendLine(`[Agent MCP] 自动配置失败\n${failures.join('\n')}`);
    const copyAction = '复制手工配置命令';
    const choice = await vscode.window.showWarningMessage(
      '部分 Agent 自动配置失败，详情已写入输出面板。',
      copyAction
    );
    if (choice === copyAction) {
      await vscode.env.clipboard.writeText(
        states
          .filter((state) => state.enabled && state.command && state.supportsMcp)
          .map((state) => state.def.mcp.handler
            ? state.def.mcp.handler.describeAdd('safs', state.mcpUrl!)
            : `${state.def.cliName} ${state.def.mcp.add('safs', state.mcpUrl!).join(' ')}`
          )
          .join('\n')
      );
    }
    return { succeeded: false, registeredAgents: [...registeredAgents] };
  }
  bridgeOutput?.appendLine(
    '[Agent MCP] Agent 集成已自动配置；已检测的 Agent 使用统一固定 HTTP MCP 路由。'
  );
  return { succeeded: true, registeredAgents: [...registeredAgents] };
}

async function setAiForwardEnabled(mount: MountConfig, enabledValue: boolean): Promise<void> {
  let integrationResult: AgentMcpSetupResult = { succeeded: true, registeredAgents: [] };
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: enabledValue
      ? `正在启用“${mount.name}”的 Agent 转发（注册 MCP）…`
      : `正在关闭“${mount.name}”的 Agent 转发…`
  }, async () => {
    const enabled = new Set(vscodeContext.globalState.get<string[]>(aiForwardMountsKey, []));
    if (enabledValue) enabled.add(mount.name);
    else enabled.delete(mount.name);
    await vscodeContext.globalState.update(aiForwardMountsKey, [...enabled]);
    agentTrace(
      'Preference',
      `挂载 ${mount.name} Agent 转发标记已设为${enabledValue ? '启用' : '关闭'}`
    );
    const current = currentRemoteLocation();
    if (!enabledValue && current?.mountName === mount.name) {
      agentTrace('Preference', `当前窗口绑定 ${mount.name}，正在停止 MCP 并移除发现记录`);
      await mcp?.stop();
      await agentWorkspacePublisher.remove();
    }
    if (enabledValue) {
      await prepareAgentCwd(mount);
      agentTrace('Preference', '先启动固定 HTTP 路由并注册 Agent，再启动当前窗口服务');
      startAgentHttpRouterLeadership(vscodeContext);
      integrationResult = await configureDetectedAgents(vscodeContext, true);
      if (current?.mountName === mount.name) {
        const server = await ensureAgentMcpServer(vscodeContext);
        if (!server.portUnavailable) await publishAgentWorkspace(vscodeContext);
      }
    } else if (enabled.size === 0) {
      agentTrace('Preference', '已无启用挂载，移除固定 MCP 注册');
      try {
        integrationResult = await configureDetectedAgents(vscodeContext, false);
      } finally {
        // 无论移除是否成功/抛错，都要停掉固定路由心跳，避免残留。
        await stopAgentHttpRouterLeadership();
      }
    }
  });
  if (enabledValue) {
    const successMessage = agentForwardingInstallMessage(
      integrationResult.registeredAgents, integrationResult.succeeded
    );
    if (successMessage) {
      void vscode.window.showInformationMessage(successMessage);
    } else {
      // 配置中的 Agent 全部未检测到或注册失败时，直接进入手工 Agent 安装流程。
      await vscode.commands.executeCommand(`${commandPrefix}.installAgentForwarding`);
    }
    return;
  }
  const enabled = new Set(vscodeContext.globalState.get<string[]>(aiForwardMountsKey, []));
  void vscode.window.showInformationMessage(
    `"${mount.name}" Agent 转发已关闭。${enabled.size === 0
      ? integrationResult.succeeded
        ? '所有转发均已关闭，固定 MCP 已移除。'
        : '所有转发均已关闭，但固定 MCP 移除失败，请查看输出。'
      : '其他已启用挂载继续共用固定 MCP。'}`
  );
}

async function prepareAgentCwd(mount: MountConfig): Promise<void> {
  try {
    const folder = await ensureFolder(mount);
    agentTrace('CWD', `Agent cwd 已可用：${vscode.Uri.parse(folderUri(folder)).fsPath}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    bridgeOutput?.appendLine(`[Agent CWD] 无法为 ${mount.name} 创建本机占位目录：${detail}`);
    void vscode.window.showWarningMessage(
      `SAFS：无法创建 Agent cwd 占位目录。Agent 可能因 ENOENT 无法启动，请查看输出。`
    );
  }
}

// ---- Guard / Error Handling (aligned with main) ----

async function guard(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logAsyncFailure('命令失败', error);
    if (error instanceof ConfigActionRequiredError) {
      const selected = await vscode.window.showErrorMessage(
        `SAFS: ${message}`,
        ...error.actions
      );
      if (selected === openConfigAction) {
        await vscode.commands.executeCommand(`${commandPrefix}.openConfig`, error.hostName);
      } else if (selected === addSshConfigAction) {
        await vscode.commands.executeCommand(`${commandPrefix}.addSshConfig`);
      }
      return;
    }
    const missingCommand = missingExecutableName(error);
    if (missingCommand) {
      bridgeOutput?.appendLine(`[缺少依赖] ${message}`);
      await vscode.window.showErrorMessage(
        `SAFS：找不到命令"${missingCommand}"，请确保 SSH 客户端已安装。`
      );
      return;
    }
    output.appendLine(`[错误] ${message}`);
    const errorHint =
      /All configured authentication methods failed/i.test(message)
        ? '：认证失败，请检查用户名/密码是否正确（或改用私钥认证）'
        : /Unable to start subsystem/i.test(message)
          ? '：服务器未提供 SFTP 子系统（可能仅支持 SSH 终端/跳板，或网关策略禁止文件传输）。请在服务器 sshd_config 中启用 Subsystem sftp，或改用支持 SFTP 的目标主机；如需 SSH 终端可尝试“SAFS: 打开远程终端”'
          : /packet length|exchange encryption keys|wrong packet|bad packet/i.test(message)
            ? '：服务器在 SSH 握手阶段返回了无效数据（网关/NSG 可能瞬断或该端口不是 SSH 服务），已自动重试 3 次仍失败'
            : '';
    await vscode.window.showErrorMessage(`SAFS: ${message}${errorHint}`);
  }
}

async function ensureSystemDependencies(): Promise<void> {
  const platform = platformAdapter.kind;
  if (platform !== 'wsl' || await hasRequiredWslDependencies()) return;
  const platformName = 'WSL';
  bridgeOutput?.appendLine(
    `[${new Date().toLocaleString()}] 检测到 ${platformName} 系统依赖缺失，开始自动安装`
  );
  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `SAFS：正在安装 ${platformName} 依赖`,
      cancellable: false
    }, async (progress) => {
      const reporter = {
        log: (message: string) => {
          if (!message) return;
          bridgeOutput?.appendLine(message);
          const latest = message.trim().split(/\r?\n/).at(-1);
          if (latest) progress.report({ message: latest.slice(0, 100) });
        },
        progress: (message: string, increment?: number) =>
          progress.report({ message, increment })
      };
      await installWslDependencies(reporter);
    });
    bridgeOutput?.appendLine(`${platformName} 系统依赖自动安装完成`);
    void vscode.window.showInformationMessage(
      `SAFS：${platformName} 依赖安装完成。`
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    bridgeOutput?.appendLine(`[依赖安装失败] ${detail}`);
    const selected = await vscode.window.showErrorMessage(
      `SAFS：${platformName} 依赖自动安装失败：${detail}`,
      '查看输出'
    );
    if (selected === '查看输出') bridgeOutput?.show(true);
  }
}

// ---- Activate / Deactivate ----

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  vscodeContext = context;
  output = vscode.window.createOutputChannel('SAFS');
  bridgeOutput = vscode.window.createOutputChannel('SAFS Log', { log: true });
  context.subscriptions.push(output, bridgeOutput);
  await recoverTerminalDiagnostics(context);
  // 独立、高优先级 ID：避免长焦点文案被底栏布局整项挤掉，也不复用
  // 旧匿名 SAFS 状态项可能已被用户隐藏的可见性偏好。
  forwardingFocusStatusBar = vscode.window.createStatusBarItem(
    'safs.agentForwardingFocus', vscode.StatusBarAlignment.Left, 10_000
  );
  forwardingFocusStatusBar.name = 'SAFS Agent 转发焦点';
  forwardingFocusStatusBar.command = `${commandPrefix}.openFolder`;
  // SFTP 入口与 SAFS SYNC 一致：独立常驻一项，转发焦点提示不再顶替它。
  safsStatusBar = vscode.window.createStatusBarItem(
    'safs.sftpEntry', vscode.StatusBarAlignment.Left, 9_999
  );
  safsStatusBar.name = 'SAFS SFTP';
  safsStatusBar.command = `${commandPrefix}.openFolder`;
  updateSafsStatusBar(false);
  safsStatusBar.show();
  context.subscriptions.push(safsStatusBar, forwardingFocusStatusBar);
  syncStatusBar = vscode.window.createStatusBarItem(
    'safs.syncStatus', vscode.StatusBarAlignment.Left, 99
  );
  syncStatusBar.name = 'SAFS 本地同步';
  context.subscriptions.push(syncStatusBar);
  syncCoordinator = new SyncCoordinator(
    vscode.Uri.joinPath(context.globalStorageUri, 'sync-coordination').fsPath
  );
  context.subscriptions.push({ dispose: () => void syncCoordinator?.dispose() });
  const logCleanup = setInterval(() => {
    output.clear();
    bridgeOutput?.clear();
  }, logClearIntervalMs);
  context.subscriptions.push({ dispose: () => clearInterval(logCleanup) });
  agentTrace('Activate', `扩展激活，workspace=${
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.toString()).join(', ') || '<none>'
  }`);

  // WSL: point the bundled scripts at resources/wsl/. VSIX packaging can
  // strip the executable bit from ssh-bridge (Windows builds store 0666), so
  // re-assert it before any terminal spawns the bridge.
  setWslBundlePath(vscode.Uri.joinPath(context.extensionUri, 'resources', 'wsl').fsPath);
  setKnownHostsFilePath(knownHostsFilePath());
  await ensureWslBridgeExecutable();
  // 依赖安装后台执行，不阻塞窗口激活（apt install 可能耗时数分钟）；
  // 终端路径另有 hasRequiredWslDependencies 守卫。
  void ensureSystemDependencies();

  registry = new RemoteFolderRegistry();
  refreshTree = () => undefined;
  pool = new SftpConnectionPool(
    async (hostName, signal) => {
      const host = await resolvedHost(context, hostName);
      const session = await connectSftp(
        host,
        platformAdapter.kind === 'wsl',
        signal,
        settings().get<string>('sshClientIdent', defaultSshClientIdent),
        hostVerifierFor(host, (message) => bridgeOutput?.appendLine(`[主机密钥] ${message}`)),
        (reason) => bridgeOutput?.appendLine(
          `[SFTP] ${host.name} SFTP 子系统不可用，回退到 SCP/exec：${reason}`
        )
      );
      agentTrace('SFTP', `${host.name} 传输通道：${session.transport}`);
      return session;
    },
    // 连接/重连/断开即时刷新底栏入口（SFTP↔SCP）与树视图；心跳仅作兜底。
    () => {
      refreshTree();
      refreshSafsEntryLabel();
    }
  );
  // 回收空闲 SFTP 连接（safs.sftp.idleConnectionTtl 秒，0 关闭），避免多主机
  // 长期挂载时连接无限累积。
  const idleTtlSec = settings().get<number>('sftp.idleConnectionTtl', 600);
  if (idleTtlSec > 0) {
    const idleTtlMs = idleTtlSec * 1000;
    const idleTimer = setInterval(() => {
      void pool.closeIdle(idleTtlMs).catch((error) =>
        logAsyncFailure('SFTP 空闲连接回收失败', error)
      );
    }, Math.min(idleTtlMs, 60_000));
    idleTimer.unref?.();
    context.subscriptions.push({ dispose: () => clearInterval(idleTimer) });
  }
  // 远程文件/目录 ↔ 本地双向同步管理器：provider 事件即时同步，低频扫描
  // 补获终端、Agent 与其他 SSH 客户端直接产生的远程变更。
  syncManager = new RemoteSyncManager(
    async (mountName) => {
      const existing = registry.get(mountName);
      if (existing) return pool.get(existing.hostName);
      // 非远程窗口（如只打开了本地目录的窗口）：按配置解析挂载并连接，
      // 这样本地变更的状态与同步也能在该窗口生效。
      const config = await readConfig();
      const mount = config.mounts.find((candidate) => candidate.name === mountName);
      if (!mount) throw new Error(`远程挂载不存在：${mountName}`);
      const folder = await ensureFolder(mount);
      return pool.get(folder.hostName);
    },
    (uri) => {
      try {
        const location = parseRemoteUri(uri.toString());
        const folder = registry.get(location.mountName);
        if (!folder) return undefined;
        return { mountName: location.mountName, remotePath: remotePathForUri(folder, location.remotePath) };
      } catch {
        return undefined;
      }
    },
    (message) => bridgeOutput?.appendLine(`[远程同步] ${message}`),
    (persist) => saveSyncTasks(persist),
    // 同步进度显示在 VS Code 底部中间（短暂消息，如“正在下载…”）。
    (message) => void vscode.window.setStatusBarMessage(message, 3000),
    (task) => syncCoordinator?.acquire(task.mountName, task.remotePath) ?? Promise.resolve(true),
    (task) => syncCoordinator?.release(task.mountName, task.remotePath) ?? Promise.resolve(),
    async (task) => {
      await syncCoordinator?.markReady(task.mountName, task.remotePath, task.localDir);
      await updateSyncStatusBar();
    },
    (task) => syncCoordinator?.isStopRequested(task.mountName, task.remotePath)
      ?? Promise.resolve(false),
    settings().get<number>('sftp.watchInterval', 5) * 1000
  );
  // 恢复上次的同步任务（指纹行随任务持久化，重载后继续增量同步）。
  for (const task of context.globalState.get<RemoteSyncTask[]>(syncTasksKey, [])) {
    void syncManager.add(task).catch((error) =>
      logAsyncFailure(`恢复同步任务失败 ${task.mountName}:${task.remotePath}`, error)
    );
  }
  void updateSyncStatusBar().catch((error) => logAsyncFailure('同步状态栏刷新失败', error));
  await guard(preloadRemoteWorkspaces);
  // Merge pi/vscode-pi conversation history from legacy SAFS session keys
  // (WSL, old extension folder) into the current key of the same mount so
  // history is not lost after platform/extension migrations.
  void (async () => {
    try {
      const config = await readConfig();
      await migratePiSessionKeys(config.mounts, (message) =>
        bridgeOutput?.appendLine(message)
      );
    } catch (error) {
      // History migration is best-effort; never block activation, but keep diagnostics.
      logAsyncFailure('Agent 会话历史迁移失败', error);
    }
  })();
  provider = new SftpFileSystemProvider(
    pool,
    registry,
    settings().get<number>('sftp.cacheTtl', 30) * 1000,
    settings().get<number>('sftp.watchInterval', 5) * 1000,
    (uri, kind, targetUri) => void syncManager?.notifyRemoteChange(uri, kind, targetUri)
  );

  const tree = new RemoteFoldersProvider(context);
  refreshTree = () => tree.refresh();
  context.subscriptions.push(
    provider,
    vscode.workspace.registerFileSystemProvider(remoteFileSystemScheme, provider, {
      isCaseSensitive: true,
      isReadonly: false
    }),
    vscode.window.registerTerminalLinkProvider({
      provideTerminalLinks: (linkContext) => provideSafsTerminalLinks(linkContext),
      handleTerminalLink: (link) => guard(
        () => handleSafsTerminalLink(link as SafsTerminalLink)
      )
    }),
    vscode.window.registerTreeDataProvider(`${commandPrefix}.mounts`, tree),
    { dispose: () => { void pool.close(); syncManager?.dispose(); } }
  );

  const command = (name: string, callback: (...args: never[]) => Promise<unknown>) => {
    context.subscriptions.push(vscode.commands.registerCommand(
      `${commandPrefix}.${name}`,
      (...args: never[]) => guard(() => callback(...args))
    ));
  };
  command('openFolder', async () => {
    await openRemoteDirectory();
    tree.refresh();
  });
  command('openFolderItem', async (mount) => {
    await openDirectoryItem(mount);
    tree.refresh();
  });
  command('switchRemoteDirectory', switchRemoteDirectory);
  command('completeRemoteDirectory', completeRemoteDirectory);
  command('syncToLocal', (uri) => syncToLocal(uri as vscode.Uri | undefined));
  command('visualDownload', (uri) => visualDownload(uri as vscode.Uri | undefined));
  command('visualUpload', (...args) => visualUpload(...args as vscode.Uri[]));
  command('openTerminal', () => openTerminal(context, undefined, undefined, undefined, true));
  command('openTerminalItem', (mount) =>
    openTerminal(context, mount, undefined, undefined, true));
  command('close', async () => {
    await disconnect();
    tree.refresh();
  });
  command('closeItem', async (mount) => {
    await disconnect(mount);
    tree.refresh();
  });
  command('status', showStatus);
  command('openConfig', () => openConfig());
  command('addSshConfig', async () => {
    await addSshConfig(context);
    tree.refresh();
  });
  const askAgentNameAndPlatform = async (
    title: string
  ): Promise<{ agentName: string; platform: AgentPlatformLabel } | undefined> => {
    const agentName = await vscode.window.showInputBox({
      title,
      prompt: '请输入使用该 URL 的 Agent 名（仅用于日志和诊断）',
      placeHolder: '例如：Codex、Claude、MyAgent',
      ignoreFocusOut: true,
      validateInput: (value) => !value.trim()
        ? '请输入 Agent 名'
        : value.trim().length > 100
          ? 'Agent 名最多 100 个字符'
          : /[\u0000-\u001f\u007f]/.test(value)
            ? 'Agent 名不能包含控制字符'
            : undefined
    });
    if (agentName === undefined) return undefined;
    const platform = await vscode.window.showQuickPick<{
      label: string; description: string; value: AgentPlatformLabel;
    }>([
      { label: 'WSL', description: 'Agent 运行在 Windows Subsystem for Linux', value: 'wsl' },
      { label: 'mac', description: 'Agent 运行在 macOS', value: 'mac' },
      { label: 'linux', description: 'Agent 运行在 Linux', value: 'linux' },
      { label: 'win', description: 'Agent 运行在 Windows', value: 'win' }
    ], {
      title: 'SAFS：选择 Agent 所在平台',
      placeHolder: '选择 wsl、mac、linux 或 win',
      ignoreFocusOut: true
    });
    if (!platform) return undefined;
    return { agentName: agentName.trim(), platform: platform.value };
  };
  command('copyStreamableHttpUrl', async () => {
    const answer = await askAgentNameAndPlatform('SAFS：复制 Streamable HTTP URL');
    if (!answer) return;
    startAgentHttpRouterLeadership(context);
    const router = await ensureAgentHttpRouter(context);
    const url = agentTaggedMcpUrl(router.url, answer.agentName, answer.platform);
    await vscode.env.clipboard.writeText(url);
    void vscode.window.showInformationMessage(
      `已复制 ${answer.agentName} 的 Streamable HTTP URL。在 Agent 的 MCP 设置中添加服务器“safs”，粘贴该地址后重启 Agent。`
    );
  });
  command('installAgentForwarding', async () => {
    const answer =
      await askAgentNameAndPlatform('SAFS：为我的Agent安装转发功能');
    if (!answer) return;
    startAgentHttpRouterLeadership(context);
    const router = await ensureAgentHttpRouter(context);
    const url = agentTaggedMcpUrl(router.url, answer.agentName, answer.platform);
    // 复制一段提示词而不是裸 URL：让 Agent 自己完成 MCP 注册，
    // 用户只需把提示词粘贴到 Agent 输入框里。
    const promptText = [
      `请为自己安装名为 safs 的 MCP 服务器（Streamable HTTP，用户级）：${url}`,
      '完成后提醒我重启并新建对话生效。该 URL 含鉴权令牌，不要外泄。'
    ].join('\n');
    await vscode.env.clipboard.writeText(promptText);
    void vscode.window.showInformationMessage(
      `已复制 ${answer.agentName} 的安装提示词。请把提示词粘贴到 Agent 输入框里，由 Agent 自动完成 SAFS 转发配置。`
    );
  });
  command('refreshExplorer', async () => tree.refresh());
  command('deleteConfigItem', async (mount) => {
    await deleteConfig(mount);
    tree.refresh();
  });
  command('openHistoryItem', async (item: HistoryItem) => {
    const syncTask = historySyncTask(item);
    if (syncTask) {
      if (!await syncCoordinator?.isReady(item.mountName, item.path, syncTask.localDir)) {
        void vscode.window.showInformationMessage(
          `正在同步 ${item.path}，本地目录准备完成后再打开。`
        );
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.openFolder', vscode.Uri.file(syncTask.localDir), true
      );
      return;
    }
    const config = await readConfig();
    const mount = config.mounts.find((m) => m.name === item.mountName);
    if (!mount) throw new Error(`远程目录配置不存在：${item.mountName}`);
    const folder = await ensureFolder(mount);
    const remoteRoot = folder.remoteRoot;
    if (!isRemotePathInsideRoot(remoteRoot, item.path)) {
      throw new Error(`远程目录路径无效：${item.path}`);
    }
    const forwarding = vscodeContext.globalState
      .get<string[]>(aiForwardMountsKey, []).includes(mount.name);
    if (forwarding) {
      startAgentHttpRouterLeadership(vscodeContext);
      await ensureAgentHttpRouter(vscodeContext);
      await configureDetectedAgents(vscodeContext, true);
    }
    const localRoot = localRootForFolder(folder);
    await ensureAgentCwdSubdirectory(localRoot, folder.remoteRoot, item.path);
    await writeLastRemoteDirectory(localRoot, folder.remoteRoot, item.path);
    await recordDirectoryHistory(vscodeContext, item.mountName, item.path);
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.parse(folderUri(folder, item.path)),
      true
    );
  });
  command('enableHistorySync', async (item: HistoryItem) => {
    await enableHistorySync(item);
    tree.refresh();
  });
  command('disableHistorySync', async (item: HistoryItem) => {
    await disableHistorySync(item);
    tree.refresh();
  });
  command('openTerminalFromHistory', async (item: HistoryItem) => {
    const config = await readConfig();
    const mount = config.mounts.find((m) => m.name === item.mountName);
    if (!mount) throw new Error(`远程目录配置不存在：${item.mountName}`);
    await recordDirectoryHistory(vscodeContext, item.mountName, item.path);
    await openTerminal(vscodeContext, mount, item.path, undefined, true);
  });
  command('deleteHistoryItem', async (item: HistoryItem) => {
    await removeHistoryEntry(vscodeContext, item.mountName, item.path);
    tree.refresh();
  });
  command('enableAiForwardItem', async (mount) => {
    await setAiForwardEnabled(mount, true);
    tree.refresh();
  });
  command('disableAiForwardItem', async (mount) => {
    await setAiForwardEnabled(mount, false);
    tree.refresh();
  });

  // VS Code Language Model tools
  const tool = <T>(
    name: string,
    callback: (input: T) => Promise<unknown>,
    confirmation = false
  ) => context.subscriptions.push(vscode.lm.registerTool<T>(name, {
    ...(confirmation ? {
      prepareInvocation: async () => ({
        invocationMessage: '正在修改远程 SFTP 文件',
        confirmationMessages: {
          title: '修改远程文件',
          message: new vscode.MarkdownString('是否允许修改远程 SFTP 工作区？')
        }
      })
    } : {}),
    invoke: async (options) => new vscode.LanguageModelToolResult([
      // 紧凑 JSON：缩进空白只会白白消耗模型 token。
      new vscode.LanguageModelTextPart(JSON.stringify(
        await callback((options.input ?? {}) as T)
      ))
    ])
  }));
  tool<{ mountName?: string; path?: string }>('safs_listRemoteFiles', async (input) =>
    remoteList({ ...input, mountName: await forwardedMountName(input.mountName) }));
  tool<{ mountName?: string }>('safs_currentRemoteFile', async (input) =>
    activeRemoteFile(await forwardedMountName(input.mountName)));
  tool<{ mountName?: string; path: string; content: string }>(
    'safs_writeRemoteFile', async (input) =>
      remoteWrite({ ...input, mountName: await forwardedMountName(input.mountName) }), true
  );
  tool<{ mountName?: string; query: string; path?: string }>(
    'safs_searchRemoteFiles', async (input) =>
      remoteSearch({ ...input, mountName: await forwardedMountName(input.mountName) })
  );
  tool<{ mountName?: string; command: string; remoteCwd?: string }>(
    'safs_runRemoteCommand', async (input) =>
      runRemote({
        ...input,
        mountName: await forwardedMountName(input.mountName),
        source: 'command_palette'
      }), true
  );

  // Terminal lifecycle
  context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
    void suggestReopeningClosedTerminal(terminal).catch((error) =>
      logAsyncFailure('终端退出处理失败', error)
    );
  }));

  // Restore workspaces on startup
  await guard(restoreRemoteWorkspaces);
  await guard(restoreSyncedLocalWorkspaceTerminal);
  tree.refresh();

  // 每次切换到远程文件或同步镜像文件时：若设置开启则同步远程终端；
  // 重开远程窗口后首次文件激活也无条件跟随（配合标签页恢复）。
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
    const uri = editor?.document.uri;
    if (!uri || (uri.scheme !== remoteFileSystemScheme && uri.scheme !== 'file')) return;
    void syncTerminalToActiveFile(uri).catch((error) =>
      logAsyncFailure('终端目录跟随调度失败', error)
    );
  }));
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void updateSyncStatusBar().catch((error) =>
        logAsyncFailure('同步状态栏刷新失败', error)
      );
    })
  );

  // Agent MCP: keep one in-extension fixed HTTP router alive, then start the
  // dynamic backend only in an enabled remote window.
  await guard(async () => {
    const enabled = new Set(context.globalState.get<string[]>(aiForwardMountsKey, []));
    const current = currentRemoteLocation();
    agentTrace(
      'Activate',
      `当前远程挂载=${current?.mountName ?? '<none>'}，启用列表=${[...enabled].join(',') || '<empty>'}`
    );
    if (enabled.size > 0) {
      agentTrace('Activate', '启动或连接固定 HTTP MCP 路由器');
      startAgentHttpRouterLeadership(context);
      await ensureAgentHttpRouter(context);
      await configureDetectedAgents(context, true);
      if (current && enabled.has(current.mountName)) {
        agentTrace('Activate', `挂载 ${current.mountName} 已启用，启动窗口动态 MCP 后端`);
        const config = await readConfig();
        const mount = config.mounts.find((candidate) => candidate.name === current.mountName);
        if (mount) await prepareAgentCwd(mount);
        const server = await ensureAgentMcpServer(context);
        if (!server.portUnavailable) {
          await publishAgentWorkspace(context);
        }
      } else {
        agentTrace('Activate', '当前不是已启用的远程窗口，仅提供固定 HTTP 路由');
      }
    } else if (enabled.size === 0) {
      agentTrace('Activate', '没有已启用挂载，清理可能残留的固定 MCP');
      await configureDetectedAgents(context, false);
    } else {
      agentTrace('Activate', '不启动 Agent MCP：当前窗口没有已启用的远程挂载');
    }
  });
  startAgentWorkspacePublishing(context);

}

export async function deactivate(): Promise<void> {
  agentTrace('Deactivate', '扩展停用，清理发现记录、MCP 和连接池');
  if (agentWorkspaceHeartbeat) clearInterval(agentWorkspaceHeartbeat);
  if (agentHttpRouterHeartbeat) clearInterval(agentHttpRouterHeartbeat);
  await agentWorkspacePublisher.remove();
  await mcp?.stop();
  await httpRouterStart?.catch(() => undefined);
  await httpRouter?.stop();
  await pool?.close();
  closeSsh2ExecSessions();
}
