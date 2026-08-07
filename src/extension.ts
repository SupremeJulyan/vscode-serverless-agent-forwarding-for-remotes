import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import * as vscode from 'vscode';
import {
  BridgeConfig, ensureConfigFile, expandHome, HostConfig, loadConfig, MountConfig,
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
  commandExists, executeCaptured,
  missingExecutableName, resolveExecutable
} from './process';
import { executeSsh2Command, Ssh2Terminal } from './ssh2-terminal';
import {
  passwordValueOffset
} from './authentication';
import { AgentMcpServer } from './agent-mcp';import { AgentHttpRouter } from './agent-http-router';
import { AgentWorkspacePublisher } from './agent-discovery';
import {
  AgentDefinition, AgentMcpCliRunner, agentSupportsMcpFor,
  resolveAgentDefinitions, runAgentMcpOperation
} from './agent-mcp-registry';
import {
  ensureAgentCwdPlaceholder, ensureAgentCwdSubdirectory, readLastRemoteDirectory,
  writeLastRemoteDirectory
} from './agent-cwd';
import { connectSftp } from './sftp/client';
import { defaultSshClientIdent, ensureSshCapabilities } from './ssh-algorithms';
import { SftpConnectionPool } from './sftp/connection-pool';
import { migratePiSessionKeys } from './pi-session-migrate';
import {
  remotePathForUri, RemoteFolder, RemoteFolderRegistry, SftpFileSystemProvider,
  workspacePathForRemote
} from './sftp/filesystem-provider';
import {
  isRemotePathInsideRoot, parseRemoteUri, remoteFileSystemScheme, remoteUri
} from './sftp/uri';
import { ensureWslBridgeExecutable, setWslBundlePath } from './wsl-bridge';
import {
  hasRequiredWslDependencies, installWslDependencies
} from './dependency-installer';
import { appendMcpCommandLog } from './mcp-log';
import {
  defaultHighRiskCommandPatterns, matchHighRiskCommand
} from './high-risk-commands';

const commandPrefix = 'safs';
const platformAdapter = createPlatformAdapter();

const platformStateKey = (name: string): string =>
  platformExtensionStateKey(name, platformAdapter.kind);
const terminalIdentityEnv = 'SERVERLESS_REMOTE_TERMINAL_ID';
const masterPasswordSecret = 'safs.masterPassword';
const agentMcpTokenSecret = platformStateKey('agentMcpToken');
const agentSetupCompletedKey = platformStateKey('agentSetupCompleted');
const aiForwardMountsKey = platformStateKey('aiForwardMounts');
const defaultConfigPath = '~/.safs/config.json';
const openConfigAction = 'Open Config';
const addSshConfigAction = 'Add SSH Config';
const reconnectRemoteTerminalAction = '重连终端';
const terminalCredentialTtlMs = 5 * 60 * 1000;
const logClearIntervalMs = 24 * 60 * 60 * 1000;

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
const openingTerminalIds = new Set<string>();
const managedRemoteTerminals = new Map<vscode.Terminal, {
  mount: MountConfig;
  remoteCwd: string;
  retryWithSystemSsh?: boolean;
}>();

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

function configPath(): string {
  const inspected = settings().inspect<string>('configPath');
  const configured = inspected?.workspaceFolderValue
    ?? inspected?.workspaceValue
    ?? inspected?.globalValue;
  if (configured) return expandHome(configured);
  return expandHome(defaultConfigPath);
}

async function readConfig(): Promise<BridgeConfig> {
  try {
    return await loadConfig(configPath());
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
  return value.replace(/([?&]token=)[^&\s'"\\]+/gi, '$1<hidden>');
}

function highRiskSettings(): {
  patterns: string[];
  action: 'deny' | 'confirm';
} {
  return {
    patterns: settings().get<string[]>(
      'highRiskCommandPatterns', defaultHighRiskCommandPatterns
    ),
    action: settings().get<'deny' | 'confirm'>('highRiskCommandAction', 'deny')
  };
}

async function executeAgentMcpCommand(
  plan: CommandPlan, signal?: AbortSignal
): Promise<Awaited<ReturnType<typeof executeCaptured>>> {
  const displayName = redactAgentMcpText(planDisplayName(plan));
  bridgeOutput?.appendLine(`[${new Date().toLocaleString()}] [Agent MCP] $ ${displayName}`);
  try {
    const result = await executeCaptured(
      { ...plan, cwd: plan.cwd ?? os.homedir() }, signal, 1024 * 1024
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
  context: vscode.ExtensionContext, confirm: boolean
): Promise<string> {
  const stored = await context.secrets.get(masterPasswordSecret);
  if (stored) return stored;
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
      await context.secrets.delete(masterPasswordSecret);
    }
  }
  const password = await promptMasterPassword(context, false);
  try {
    return await decryptPassword(encrypted, password);
  } catch (error) {
    await context.secrets.delete(masterPasswordSecret);
    throw error;
  }
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
    return existing;
  }
  agentTrace('SFTP', `开始连接挂载 ${mount.name}，host=${mount.host}`);
  const config = await readConfig();
  const resolved = resolveMount(config, mount);
  const session = await pool.get(resolved.hostConfig.name);
  const remoteRoot = await session.realpath(mount.remote_path);
  const stat = await session.stat(remoteRoot);
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

function localRootForFolder(folder: RemoteFolder): string {
  return vscode.Uri.from({ scheme: 'file', path: folder.workspaceRoot }).fsPath;
}

async function cachedRemoteDirectory(folder: RemoteFolder): Promise<string> {
  const localRoot = localRootForFolder(folder);
  const cached = await readLastRemoteDirectory(localRoot);
  if (!cached || !isRemotePathInsideRoot(folder.remoteRoot, cached)) return folder.remoteRoot;
  try {
    const session = await pool.get(folder.hostName);
    const resolved = await session.realpath(cached);
    if (!isRemotePathInsideRoot(folder.remoteRoot, resolved)) return folder.remoteRoot;
    if ((await session.stat(resolved)).type !== 'directory') return folder.remoteRoot;
    await ensureAgentCwdSubdirectory(localRoot, folder.remoteRoot, resolved);
    return resolved;
  } catch {
    await writeLastRemoteDirectory(localRoot, folder.remoteRoot, folder.remoteRoot);
    return folder.remoteRoot;
  }
}

async function openRemoteFolder(requested?: MountConfig): Promise<void> {
  const mount = requested ?? await selectMount('选择要打开的 SFTP 远程文件夹');
  if (!mount) return;
  const forwarding = vscodeContext.globalState
    .get<string[]>(aiForwardMountsKey, []).includes(mount.name);
  agentTrace('Open', `准备打开 ${mount.name}，Agent 转发=${forwarding ? '启用' : '关闭'}`);
  if (forwarding) {
    // Start the stable HTTP endpoint in window A before window B is created,
    // so Agents in B never need to spawn a stdio router from a virtual cwd.
    startAgentHttpRouterLeadership(vscodeContext);
    await ensureAgentHttpRouter(vscodeContext);
    await configureDetectedAgents(vscodeContext, true);
  }
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在连接 ${mount.name}…`,
    cancellable: false
  }, async (progress) => {
    progress.report({ message: '正在验证远程目录…' });
    const folder = await ensureFolder(mount);
    const remoteDirectory = await cachedRemoteDirectory(folder);
    agentTrace('Open', `创建新窗口，workspace=${folderUri(folder, remoteDirectory)}`);
    progress.report({ message: '正在打开工作区…' });
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.parse(folderUri(folder, remoteDirectory)),
      true
    );
  });
}

async function switchRemoteDirectory(): Promise<void> {
  const location = currentRemoteLocation();
  if (!location) {
    throw new Error('当前窗口不是 SAFS 远程工作区');
  }
  const config = await readConfig();
  const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
  if (!mount) throw new Error(`远程文件夹配置不存在：${location.mountName}`);
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
  agentTrace('Open', `当前窗口切换远程目录：${location.remotePath} -> ${resolved}`);
  await vscode.commands.executeCommand(
    'vscode.openFolder', vscode.Uri.parse(folderUri(folder, resolved)), false
  );
}

async function promptRemoteDirectory(
  session: import('./sftp/session').SftpSession,
  remoteRoot: string,
  currentPath: string,
  mountName: string
): Promise<string | undefined> {
  const picker = vscode.window.createQuickPick<vscode.QuickPickItem>();
  picker.title = `切换远程目录：${mountName}`;
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
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === remoteFileSystemScheme) {
    return resolveLocation(parseRemoteUri(active.toString()));
  }
  return undefined;
}

// ---- openTerminal (aligned with main) ----

async function suggestReopeningClosedTerminal(terminal: vscode.Terminal): Promise<void> {
  const reopen = managedRemoteTerminals.get(terminal);
  managedRemoteTerminals.delete(terminal);
  if (!reopen || terminal.exitStatus?.reason !== vscode.TerminalExitReason.Process) {
    return;
  }
  // Reconnect into the remote directory currently open in this window
  // (kept in sync by SAFS: 切换远程目录), falling back to the cwd the
  // terminal was originally opened with.
  const location = currentRemoteLocation();
  const remoteCwd = location && location.mountName === reopen.mount.name
    ? location.remotePath
    : reopen.remoteCwd;
  if (reopen.retryWithSystemSsh) {
    void vscode.window.showInformationMessage(
      `SAFS: 内置终端与该服务器不兼容，已改用系统 SSH 重连“${reopen.mount.name}”。`
    );
    await openTerminal(vscodeContext, reopen.mount, remoteCwd, undefined, true, true);
    return;
  }
  const selected = await vscode.window.showInformationMessage(
    `远程终端“${terminal.name}”已退出。`,
    reconnectRemoteTerminalAction
  );
  if (selected === reconnectRemoteTerminalAction) {
    await openTerminal(vscodeContext, reopen.mount, remoteCwd, undefined, true);
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
  loadedConfig?: BridgeConfig, forceNew = false, forceSystemSsh = false
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
  const remoteCwd = requestedRemoteCwd
    ?? (location?.mountName === mount.name ? location.remotePath : folder.remoteRoot);
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
      if (platformUsesAskpass(platformAdapter.kind)) {
        credentials = await createAskpassCredentials(resolved.hostConfig.password!);
      }
    }
    const bridgePasswordEnv = await bridgeMasterPasswordEnv(context, resolved.hostConfig);
    // Probe the installed OpenSSH first so the legacy algorithm flags in the
    // plan match what this client understands (macOS/Linux ship a wide range
    // of OpenSSH versions, and old or new clients reject the fixed flags).
    await warmSshCliCapabilities();
    const plan = platformAdapter.terminal(resolved.hostConfig, remoteCwd, {
      reuseSshConnection: settings().get<boolean>('reuseSshConnection', true),
      bridgeMasterPassword: bridgePasswordEnv.WSL_VPN_MASTER_PASSWORD,
      bridgeConfigPath: configPath()
    });
    const terminalCommand = await resolveExecutable(plan.command, plan.env);
    const terminalStartedAt = performance.now();
    const useBuiltinSsh = !forceSystemSsh
      && platformAdapter.kind === 'windows'
      && Boolean(resolved.hostConfig.password)
      && !resolved.hostConfig.private_key_path;
    const terminal = useBuiltinSsh
      ? (() => {
        let created!: vscode.Terminal;
        const pty = new Ssh2Terminal(
          context, resolved.hostConfig, resolved.hostConfig.password!, remoteCwd,
          (error) => {
            // Server rejected the pty/shell negotiation (gateway appliance):
            // mark this terminal for a system-ssh retry instead of the
            // built-in ssh2 transport.
            if (builtinSshFallbackPattern.test(error.message)) {
              const entry = managedRemoteTerminals.get(created);
              if (entry) entry.retryWithSystemSsh = true;
            }
          }
        );
        created = vscode.window.createTerminal({
          name: terminalName,
          pty,
          isTransient: true
        });
        return created;
      })()
      : vscode.window.createTerminal({
        name: terminalName,
        shellPath: terminalCommand,
        shellArgs: plan.args,
        env: {
          SSH_BRIDGE_MOUNT_NAME: mount.name,
          [terminalIdentityEnv]: terminalId,
          ...plan.env,
          ...bridgePasswordEnv,
          ...credentials?.env
        },
        cwd: os.homedir(),
        isTransient: true
      });
    performanceLine(`${mount.name} SSH 终端创建（不含远端握手）`, terminalStartedAt);
    managedRemoteTerminals.set(terminal, { mount, remoteCwd });
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
  const existingMountIndex = config.mounts.findIndex((item) => item.name === normalizedName);
  if ((existingIndex >= 0 || existingMountIndex >= 0)
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

  const mount: MountConfig = {
    name: normalizedName,
    host: normalizedName,
    remote_path: '.',
    remote_terminal: 'open'
  };
  if (existingMountIndex >= 0) config.mounts[existingMountIndex] = mount;
  else config.mounts.push(mount);

  config.encrypt_passwords = true;
  await saveConfig(configPath(), config);
  void vscode.window.showInformationMessage(`已保存 SFTP 配置"${normalizedName}"`);
}

// ---- MCP / Remote Ops ----

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function mountAndFolder(mountName: string): Promise<{
  mount: MountConfig;
  folder: RemoteFolder;
}> {
  const config = await readConfig();
  const mount = config.mounts.find((candidate) => candidate.name === mountName);
  if (!mount) throw new Error(`远程文件夹不存在：${mountName}`);
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
 * 解析远程路径（绝对路径直接规范化，相对路径基于挂载根目录），
 * 不限制在远程工作区内——只读工具（list/read/search）允许访问工作区外路径。
 */
function resolveRemotePath(folder: RemoteFolder, value = '.'): string {
  return value.startsWith('/')
    ? path.posix.normalize(value)
    : path.posix.resolve(folder.remoteRoot, value);
}

async function remoteList(input: { mountName: string; path?: string }): Promise<unknown> {
  const { mount, folder } = await mountAndFolder(input.mountName);
  const remotePath = resolveRemotePath(folder, input.path);
  const entries = await (await pool.get(folder.hostName)).readDirectory(remotePath);
  return {
    mountName: mount.name,
    path: remotePath,
    entries: entries.map(({ name, type }) => ({ name, type }))
  };
}

async function remoteRead(input: {
  mountName: string; path: string; offset?: number; length?: number;
}): Promise<unknown> {
  const { mount, folder } = await mountAndFolder(input.mountName);
  const remotePath = resolveRemotePath(folder, input.path);
  const bytes = await (await pool.get(folder.hostName)).readFile(remotePath);
  const offset = input.offset ?? 0;
  const end = input.length ? offset + input.length : bytes.length;
  const selected = bytes.slice(offset, end);
  return {
    mountName: mount.name,
    path: remotePath,
    offset,
    bytes: selected.length,
    truncated: end < bytes.length,
    content: new TextDecoder().decode(selected)
  };
}

async function remoteWrite(input: {
  mountName: string; path: string; content: string;
}): Promise<unknown> {
  const { folder } = await mountAndFolder(input.mountName);
  const remotePath = toolPath(folder, input.path);
  const uri = vscode.Uri.parse(folderUri(folder, remotePath));
  const content = new TextEncoder().encode(input.content);
  await provider.writeFile(uri, content, { create: true, overwrite: true });
  return { mountName: input.mountName, path: remotePath, bytes: content.length };
}

async function executeRemoteCommand(
  context: vscode.ExtensionContext,
  input: { command: string; mountName: string; remoteCwd?: string; source?: string },
  token?: vscode.CancellationToken
): Promise<Record<string, unknown>> {
  if (!input.command?.trim()) throw new Error('Remote command must not be empty.');
  const { mount, folder } = await mountAndFolder(input.mountName);
  const requestedCwd = toolPath(folder, input.remoteCwd);
  const remoteCwd = await (await pool.get(mount.host)).realpath(requestedCwd);
  if (!isRemotePathInsideRoot(folder.remoteRoot, remoteCwd)) {
    throw new Error(`远程工作目录通过符号链接超出工作区：${requestedCwd}`);
  }
  const source = input.source ?? 'mcp';
  const logFailure = (error: unknown): void => {
    bridgeOutput?.appendLine(
      `[MCP 命令日志] 写入失败：${error instanceof Error ? error.message : String(error)}`
    );
  };
  if (source === 'mcp') {
    const { patterns, action } = highRiskSettings();
    const matched = matchHighRiskCommand(input.command, patterns);
    if (matched) {
      void appendMcpCommandLog({
        source: 'high_risk',
        mountName: mount.name,
        remoteCwd,
        command: input.command
      }).catch(logFailure);
      if (action === 'deny') {
        bridgeOutput?.appendLine(
          `[高危指令拦截] 拒绝执行：${input.command}（规则：${matched}）`
        );
        throw new Error(
          `高危指令已被 SAFS 拦截（规则：${matched}）：${input.command}`
        );
      }
      const approved = await vscode.window.showWarningMessage(
        `Agent 请求执行高危指令，是否允许？\n\n${input.command}\n\n匹配规则：${matched}`,
        { modal: true },
        '允许执行'
      ) === '允许执行';
      if (!approved) {
        bridgeOutput?.appendLine(
          `[高危指令拦截] 用户拒绝：${input.command}（规则：${matched}）`
        );
        throw new Error(
          `高危指令已被用户拒绝（规则：${matched}）：${input.command}`
        );
      }
      bridgeOutput?.appendLine(
        `[高危指令拦截] 用户已批准：${input.command}（规则：${matched}）`
      );
    }
  }
  appendMcpCommandLog({
    source,
    mountName: mount.name,
    remoteCwd,
    command: input.command
  }).catch(logFailure);
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
    try {
      let result;
      if (platformAdapter.kind === 'windows') {
        bridgeOutput?.appendLine(
          `[${new Date().toLocaleString()}] [Agent MCP] $ ${input.command} (cwd: ${remoteCwd})`
        );
        try {
          result = await executeSsh2Command(
            context, resolved.hostConfig, resolved.hostConfig.password,
            remoteCwd, input.command, controller.signal
          );
          bridgeOutput?.appendLine(
            `[Agent MCP] [${result.exitCode === 0 ? '完成' : `失败: exit ${result.exitCode}`}] ${input.command}`
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          bridgeOutput?.appendLine(`[Agent MCP] [失败] ${input.command}: ${detail}`);
          throw error;
        }
      } else {
        await warmSshCliCapabilities();
        const plan = platformAdapter.exec(resolved.hostConfig, remoteCwd, input.command, {
          reuseSshConnection: settings().get<boolean>('reuseSshConnection', true),
          bridgeConfigPath: configPath()
        });
        plan.env = {
          ...plan.env,
          ...await bridgeMasterPasswordEnv(context, resolved.hostConfig),
          ...credentials?.env
        };
        result = await executeAgentMcpCommand(plan, controller.signal);
      }
      return {
        mountName: mount.name,
        remoteCwd,
        command: input.command,
        ...result
      };
    } finally {
      cancellation?.dispose();
    }
  } finally {
    await credentials?.cleanup();
  }
}

async function runRemote(input: {
  mountName: string; command: string; remoteCwd?: string; source?: string;
}): Promise<unknown> {
  return executeRemoteCommand(vscodeContext, { ...input, source: input.source ?? 'mcp' });
}

async function remoteSearch(input: {
  mountName: string; query: string; path?: string;
}): Promise<unknown> {
  const { folder } = await mountAndFolder(input.mountName);
  const requestedPath = resolveRemotePath(folder, input.path);
  const searchPath = await (await pool.get(folder.hostName)).realpath(requestedPath);
  return executeRemoteCommand(vscodeContext, {
    mountName: input.mountName,
    remoteCwd: folder.remoteRoot,
    source: 'remote_search',
    command: `grep -rIn --exclude-dir=.git -- ${shellQuote(input.query)} ${
      shellQuote(searchPath)
    } | head -n 1000`
  });
}

// ---- Tree View ----

class RemoteFoldersProvider implements vscode.TreeDataProvider<MountConfig> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(mount: MountConfig): vscode.TreeItem {
    const connectionState = pool.state(mount.host);
    const connected = registry.get(mount.name) !== undefined && connectionState === 'connected';
    const aiForwarded = this.context.globalState
      .get<string[]>(aiForwardMountsKey, []).includes(mount.name);
    const item = new vscode.TreeItem(mount.name);
    const connectionLabel = connected
      ? '已连接'
      : connectionState === 'connecting' || connectionState === 'reconnecting'
        ? '连接中'
        : connectionState === 'error' ? '连接错误' : '未连接';
    item.description = `SFTP：${connectionLabel} · Agent 转发：${aiForwarded ? '已开启' : '已关闭'}`;
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
      aiForwarded ? 'Agent 转发：已开启' : 'Agent 转发：已关闭',
    ].join('\n'));
    item.command = {
      command: `${commandPrefix}.openFolderItem`,
      title: '打开远程文件夹',
      arguments: [mount]
    };
    return item;
  }

  async getChildren(): Promise<MountConfig[]> {
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
}

// ---- Workspace restore ----

async function restoreRemoteWorkspaces(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders?.filter(
    (folder) => folder.uri.scheme === remoteFileSystemScheme
  ) ?? [];
  if (folders.length === 0) return;
  const config = await readConfig();
  for (const workspace of folders) {
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
      await openTerminal(vscodeContext, mount, openedRemotePath);
    }
  }
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
  if (registry.get(mount.name)) throw new Error('请先断开该 SFTP 连接');
  if (await vscode.window.showWarningMessage(
    `确定删除"${mount.name}"配置吗？`, { modal: true }, '删除'
  ) !== '删除') return;
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
  return Promise.all(config.mounts
    .filter((mount) => enabled.has(mount.name))
    .map(async (mount) => {
      const folder = await ensureFolder(mount);
      return {
        name: mount.name,
        workspaceUri: folderUri(folder),
        remoteRoot: folder.remoteRoot,
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
          { log: (message) => bridgeOutput?.appendLine(`[Agent HTTP Router] ${message}`) }
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
  const retry = () => void ensureAgentHttpRouter(context).catch((error) => {
    bridgeOutput?.appendLine(
      `[Agent HTTP Router] ${error instanceof Error ? error.message : String(error)}`
    );
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
            remoteRoot: workspacePath,
            host: mount.host
          };
        },
        list: async (input) => remoteList({
          ...input, mountName: forwardedWindowMountName(context, boundMountName, input.mountName)
        }),
        read: async (input) => remoteRead({
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
    await agentWorkspacePublisher.remove();
    return;
  }
  const folder = await ensureFolder(mount);
  await agentWorkspacePublisher.publish({
    focused: vscode.window.state.focused,
    execution: 'remote',
    workspaceUri: folderUri(folder),
    mountName: mount.name,
    remoteRoot: folder.remoteRoot,
    host: mount.host,
    mcpUrl: mcp.url
  });
  const state = `published:${mount.name}:${mcp.url}:${vscode.window.state.focused}`;
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
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    {
      dispose: () => {
        if (agentWorkspaceHeartbeat) clearInterval(agentWorkspaceHeartbeat);
        agentWorkspaceHeartbeat = undefined;
        void agentWorkspacePublisher.remove();
      }
    }
  );
}

// ---- Agent 通用转发定义（配置项为 Agent CLI 名）----

// 类型与内置定义见 agent-mcp-registry.ts（AgentDefinition、builtinAgentDefinitions、
// genericAgentDefinition、resolveAgentDefinitions、agentSupportsMcpFor、runAgentMcpOperation）。

async function detectAgentCommand(def: AgentDefinition): Promise<string | undefined> {
  // 纯 handler 的 Agent（如 pi）不需要 CLI：MCP 注册由 handler 直接写
  // 配置文件完成（~/.pi/agent/mcp.json），跳过 PATH 与扩展内置 CLI 检测。
  if (def.mcp.handler) return def.cliName;
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
const mcpRunner: AgentMcpCliRunner = {
  run: (command, args) => executeAgentMcpCommand({ command, args }),
  log: (message) => bridgeOutput?.appendLine(
    `[${new Date().toLocaleString()}] [Agent MCP] $ ${message}`
  )
};

async function configureDetectedAgents(
  context: vscode.ExtensionContext, shouldRegister: boolean
): Promise<boolean> {
  const router = shouldRegister ? await ensureAgentHttpRouter(context) : httpRouter;
  const routerUrl = router?.url;
  const saved = context.globalState.get<unknown>(agentSetupCompletedKey);
  const configured = new Set(Array.isArray(saved) ? saved.filter(
    (item): item is string => typeof item === 'string'
  ) : []);
  const forwardingAgents = settings().get<string[]>(
    'agentForwardingAgents', ['codex', 'claude']
  );
  const definitions = resolveAgentDefinitions(forwardingAgents);
  bridgeOutput?.appendLine(
    `[Agent MCP] 转发目标：${[...forwardingAgents].join(', ') || '<empty>'}`
  );

  interface AgentState {
    def: AgentDefinition;
    command?: string;
    enabled: boolean;
    fixedExists: boolean;
    fixedConfigured: boolean;
    supportsMcp: boolean;
  }

  const states: AgentState[] = [];
  for (const def of definitions) {
    const enabled = forwardingAgents.some(
      (name) => name === def.cliName || def.legacyIds?.includes(name)
    );
    const command = await detectAgentCommand(def);
    if (!command) {
      bridgeOutput?.appendLine(
        `[Agent MCP] Agent 检测：${def.displayName} 未找到 CLI${
          def.extensionId ? `（PATH 与 VS Code 扩展 ${def.extensionId} 均无）` : ''
        }`
      );
      states.push({
        def, command: undefined, enabled,
        fixedExists: false, fixedConfigured: false, supportsMcp: true
      });
      continue;
    }
    const prerequisiteMissing = def.mcp.handler?.prerequisiteCheck
      ? await def.mcp.handler.prerequisiteCheck()
      : undefined;
    if (prerequisiteMissing) {
      bridgeOutput?.appendLine(
        `[Agent MCP] ${def.displayName} 前置条件缺失，跳过自动注册：${prerequisiteMissing}`
      );
      states.push({
        def, command, enabled,
        fixedExists: false, fixedConfigured: false, supportsMcp: true
      });
      continue;
    }
    const status = await runAgentMcpOperation(def, command, 'get', undefined, mcpRunner);
    const output = `${status.stdout}\n${status.stderr}`;
    const fixedExists = status.exitCode === 0;
    const supportsMcp = agentSupportsMcpFor(def, status);
    const fixedConfigured = fixedExists && Boolean(routerUrl && output.includes(routerUrl));
    states.push({ def, command, enabled, fixedExists, fixedConfigured, supportsMcp });
  }

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
  for (const state of states) {
    const key = `${state.def.cliName}:safs`;
    if (!state.enabled || !state.fixedConfigured) configured.delete(key);
  }
  if (needsSetup.length === 0 && needsDisable.length === 0) {
    await context.globalState.update(agentSetupCompletedKey, [...configured]);
    return true;
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
    const result = await runAgentMcpOperation(state.def, state.command!, 'remove', undefined, mcpRunner);
    if (result.exitCode === 0) {
      configured.delete(`${state.def.cliName}:safs`);
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
      const removed = await runAgentMcpOperation(state.def, state.command!, 'remove', undefined, mcpRunner);
      if (removed.exitCode !== 0) {
        canAdd = false;
        failures.push(
          `${state.def.displayName} MCP migration remove: ${removed.stderr || removed.stdout}`
        );
      }
    }
    if (canAdd) {
      const result = await runAgentMcpOperation(state.def, state.command!, 'add', routerUrl!, mcpRunner);
      if (result.exitCode !== 0 && !/already exists/i.test(`${result.stdout}\n${result.stderr}`)) {
        failures.push(`${state.def.displayName}: ${result.stderr || result.stdout}`);
      } else {
        configured.add(`${state.def.cliName}:safs`);
        bridgeOutput?.appendLine(
          `[Agent MCP] ${state.def.displayName} 固定 HTTP MCP 路由注册成功`
        );
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
            ? state.def.mcp.handler.describeAdd('safs', routerUrl!)
            : `${state.def.cliName} ${state.def.mcp.add('safs', routerUrl!).join(' ')}`
          )
          .join('\n')
      );
    }
    return false;
  }
  bridgeOutput?.appendLine(
    '[Agent MCP] Agent 集成已自动配置；已检测的 Agent 使用统一固定 HTTP MCP 路由。'
  );
  return true;
}

async function setAiForwardEnabled(mount: MountConfig, enabledValue: boolean): Promise<void> {
  const enabled = new Set(vscodeContext.globalState.get<string[]>(aiForwardMountsKey, []));
  if (enabledValue) enabled.add(mount.name);
  else enabled.delete(mount.name);
  await vscodeContext.globalState.update(aiForwardMountsKey, [...enabled]);
  agentTrace(
    'Preference',
    `挂载 ${mount.name} Agent 转发标记已设为${enabledValue ? '启用' : '关闭'}`
  );
  const current = currentRemoteLocation();
  let integrationSucceeded = true;
  if (!enabledValue && current?.mountName === mount.name) {
    agentTrace('Preference', `当前窗口绑定 ${mount.name}，正在停止 MCP 并移除发现记录`);
    await mcp?.stop();
    await agentWorkspacePublisher.remove();
  }
  if (enabledValue) {
    await prepareAgentCwd(mount);
    agentTrace('Preference', '先启动固定 HTTP 路由并注册 Agent，再启动当前窗口服务');
    startAgentHttpRouterLeadership(vscodeContext);
    integrationSucceeded = await configureDetectedAgents(vscodeContext, true);
    if (current?.mountName === mount.name) {
      const server = await ensureAgentMcpServer(vscodeContext);
      if (!server.portUnavailable) await publishAgentWorkspace(vscodeContext);
    }
  } else if (enabled.size === 0) {
    agentTrace('Preference', '已无启用挂载，移除固定 MCP 注册');
    integrationSucceeded = await configureDetectedAgents(vscodeContext, false);
    await stopAgentHttpRouterLeadership();
  }
  void vscode.window.showInformationMessage(
    `"${mount.name}" Agent 转发已${enabledValue ? '启用' : '关闭'}。${enabledValue
      ? integrationSucceeded
        ? '固定 HTTP MCP 已注册；当前远程窗口可用时会立即启动转发服务。'
        : '固定 MCP 未全部配置成功，请查看输出。'
      : enabled.size === 0
        ? integrationSucceeded
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
  await ensureWslBridgeExecutable();
  await ensureSystemDependencies();

  registry = new RemoteFolderRegistry();
  let refreshTree: () => void = () => undefined;
  pool = new SftpConnectionPool(
    async (hostName, signal) =>
      connectSftp(
        await resolvedHost(context, hostName),
        platformAdapter.kind === 'wsl',
        signal,
        settings().get<string>('sshClientIdent', defaultSshClientIdent)
      ),
    () => refreshTree()
  );
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
    } catch {
      // History migration is best-effort; never block activation.
    }
  })();
  provider = new SftpFileSystemProvider(
    pool,
    registry,
    settings().get<number>('sftp.cacheTtl', 5) * 1000,
    settings().get<number>('sftp.watchInterval', 5) * 1000
  );

  const tree = new RemoteFoldersProvider(context);
  refreshTree = () => tree.refresh();
  context.subscriptions.push(
    provider,
    vscode.workspace.registerFileSystemProvider(remoteFileSystemScheme, provider, {
      isCaseSensitive: true,
      isReadonly: false
    }),
    vscode.window.registerTreeDataProvider(`${commandPrefix}.mounts`, tree),
    { dispose: () => void pool.close() }
  );

  const command = (name: string, callback: (...args: never[]) => Promise<unknown>) => {
    context.subscriptions.push(vscode.commands.registerCommand(
      `${commandPrefix}.${name}`,
      (...args: never[]) => guard(() => callback(...args))
    ));
  };
  command('openFolder', async () => {
    await openRemoteFolder();
    tree.refresh();
  });
  command('openFolderItem', async (mount) => {
    await openRemoteFolder(mount);
    tree.refresh();
  });
  command('switchRemoteDirectory', switchRemoteDirectory);
  command('completeRemoteDirectory', completeRemoteDirectory);
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
  command('copyDesktopAgentMcpUrl', async () => {
    startAgentHttpRouterLeadership(context);
    const router = await ensureAgentHttpRouter(context);
    await vscode.env.clipboard.writeText(router.url);
    void vscode.window.showInformationMessage(
      '已复制桌面版 Agent MCP 地址。在桌面版的 Settings > MCP servers 中添加 Streamable HTTP 服务器“safs”，粘贴该地址后重启 Agent。'
    );
  });
  command('refreshExplorer', async () => tree.refresh());
  command('deleteConfigItem', async (mount) => {
    await deleteConfig(mount);
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
      new vscode.LanguageModelTextPart(JSON.stringify(await callback(options.input), null, 2))
    ])
  }));
  tool<{ mountName?: string; path?: string }>('safs_listRemoteFiles', async (input) =>
    remoteList({ ...input, mountName: await forwardedMountName(input.mountName) }));
  tool<{ mountName?: string; path: string; offset?: number; length?: number }>(
    'safs_readRemoteFile', async (input) =>
      remoteRead({ ...input, mountName: await forwardedMountName(input.mountName) })
  );
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
    void suggestReopeningClosedTerminal(terminal);
  }));

  // Restore workspaces on startup
  await guard(restoreRemoteWorkspaces);
  tree.refresh();

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

  // Status bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.name = 'SAFS';
  statusBar.text = '$(remote) Serverless SFTP';
  statusBar.tooltip = '打开 SFTP 远程文件夹';
  statusBar.command = `${commandPrefix}.openFolder`;
  statusBar.show();
  context.subscriptions.push(statusBar);
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
}
