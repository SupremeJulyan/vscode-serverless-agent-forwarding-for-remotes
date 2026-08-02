import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { access, readdir } from 'node:fs/promises';
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
  CommandPlan, createPlatformAdapter, defaultAgentMcpPort,
  platformExtensionStateKey
} from './platform';
import {
  commandExists, executeCaptured, missingExecutableName,
  resolveExecutable
} from './process';
import { executeSsh2Command, Ssh2Terminal } from './ssh2-terminal';
import {
  passwordValueOffset
} from './authentication';
import { AgentMcpServer } from './agent-mcp';
import { maintainAgentGuidance } from './agent-guidance';
import { connectSftp } from './sftp/client';
import { SftpConnectionPool } from './sftp/connection-pool';
import {
  RemoteFolder, RemoteFolderRegistry, SftpFileSystemProvider
} from './sftp/filesystem-provider';
import {
  isRemotePathInsideRoot, parseRemoteUri, remoteFileSystemScheme, remoteUri
} from './sftp/uri';
import { setWslBundlePath } from './wsl-bridge';

const commandPrefix = 'serverlessRemote';
const platformAdapter = createPlatformAdapter();

const platformStateKey = (name: string): string =>
  platformExtensionStateKey(name, platformAdapter.kind);
const terminalIdentityEnv = 'SERVERLESS_REMOTE_TERMINAL_ID';
const masterPasswordSecret = 'serverlessRemote.masterPassword';
const agentMcpTokenSecret = platformStateKey('agentMcpToken');
const agentSetupCompletedKey = platformStateKey('agentSetupCompleted');
const aiForwardMountsKey = platformStateKey('aiForwardMounts');
const defaultNativeConfigPath = '~/serverless-remote-ssh/config.json';
const defaultWslConfigPath = '~/.wsl-vpn-ssh/config.json';
const openConfigAction = 'Open Config';
const addSshConfigAction = 'Add SSH Config';
const openRemoteTerminalAction = 'Open Remote Terminal';
const terminalCredentialTtlMs = 5 * 60 * 1000;

let output: vscode.OutputChannel;
let bridgeOutput: vscode.OutputChannel | undefined;
let mcp: AgentMcpServer | undefined;
let vscodeContext: vscode.ExtensionContext;
let pool: SftpConnectionPool;
let registry: RemoteFolderRegistry;
let provider: SftpFileSystemProvider;
const openingTerminalIds = new Set<string>();

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
  return vscode.workspace.getConfiguration('serverlessRemote');
}

function configPath(): string {
  const inspected = settings().inspect<string>('configPath');
  const configured = inspected?.workspaceFolderValue
    ?? inspected?.workspaceValue
    ?? inspected?.globalValue;
  const fallback = platformAdapter.kind === 'wsl' ? defaultWslConfigPath : defaultNativeConfigPath;
  return expandHome(configured ?? fallback);
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

async function executeAgentMcpCommand(
  plan: CommandPlan, signal?: AbortSignal
): Promise<Awaited<ReturnType<typeof executeCaptured>>> {
  const displayName = redactAgentMcpText(planDisplayName(plan));
  bridgeOutput?.show(true);
  bridgeOutput?.appendLine(`[${new Date().toLocaleString()}] [Agent MCP] $ ${displayName}`);
  try {
    const result = await executeCaptured(plan, signal, 1024 * 1024, {
      stdout: (chunk) => bridgeOutput?.append(chunk),
      stderr: (chunk) => bridgeOutput?.append(chunk)
    });
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
    await pool.get(existing.hostName);
    return existing;
  }
  const config = await readConfig();
  const resolved = resolveMount(config, mount);
  const session = await pool.get(resolved.hostConfig.name);
  const remoteRoot = await session.realpath(mount.remote_path);
  const stat = await session.stat(remoteRoot);
  if (stat.type !== 'directory') throw new Error(`远程路径不是目录：${remoteRoot}`);
  const folder = { mountName: mount.name, hostName: mount.host, remoteRoot };
  registry.set(folder);
  return folder;
}

async function openRemoteFolder(requested?: MountConfig): Promise<void> {
  const mount = requested ?? await selectMount('选择要打开的 SFTP 远程文件夹');
  if (!mount) return;
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在连接 ${mount.name}…`,
    cancellable: false
  }, async () => {
    const folder = await ensureFolder(mount);
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.parse(remoteUri(folder.mountName, folder.remoteRoot)),
      true
    );
  });
}

function currentRemoteLocation(): { mountName: string; remotePath: string } | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === remoteFileSystemScheme) return parseRemoteUri(active.toString());
  const workspace = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.uri.scheme === remoteFileSystemScheme
  );
  return workspace ? parseRemoteUri(workspace.uri.toString()) : undefined;
}

// ---- openTerminal (aligned with main) ----

function isManagedRemoteTerminal(terminal: vscode.Terminal): boolean {
  const options = terminal.creationOptions;
  return 'env' in options && typeof options.env?.[terminalIdentityEnv] === 'string';
}

async function suggestReopeningClosedTerminal(terminal: vscode.Terminal): Promise<void> {
  if (!isManagedRemoteTerminal(terminal)
    || terminal.exitStatus?.reason !== vscode.TerminalExitReason.Process) {
    return;
  }
  const selected = await vscode.window.showInformationMessage(
    `远程终端"${terminal.name}"已退出。请运行"Serverless Remote SSH: Open Remote Terminal"重新打开。`,
    openRemoteTerminalAction
  );
  if (selected === openRemoteTerminalAction) {
    await vscode.commands.executeCommand(`${commandPrefix}.openTerminal`);
  }
}

async function openTerminal(
  context: vscode.ExtensionContext, requestedMount?: MountConfig, requestedRemoteCwd?: string,
  loadedConfig?: BridgeConfig, forceNew = false
): Promise<{ terminal: vscode.Terminal; created: boolean } | undefined> {
  const config = loadedConfig ?? await readConfig();
  const location = requestedMount ? undefined : currentRemoteLocation();
  const mount = requestedMount
    ?? config.mounts.find((candidate) => candidate.name === location?.mountName)
    ?? await selectMount('Select a remote terminal');
  if (!mount) return undefined;
  const folder = await ensureFolder(mount);
  const remoteRoot = path.posix.normalize(mount.remote_path);
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
      // An interactive Windows OpenSSH process owns a terminal and reads its
      // password from that terminal. ASKPASS is suitable for background
      // commands, but cannot silently replace a PTY password prompt.
      if (platformUsesAskpass(platformAdapter.kind)) {
        credentials = await createAskpassCredentials(resolved.hostConfig.password!);
      }
    }
    const bridgePasswordEnv = await bridgeMasterPasswordEnv(context, resolved.hostConfig);
    const plan = platformAdapter.terminal(resolved.hostConfig, remoteCwd, {
      reuseSshConnection: settings().get<boolean>('reuseSshConnection', true),
      bridgeMasterPassword: bridgePasswordEnv.WSL_VPN_MASTER_PASSWORD
    });
    const terminalCommand = await resolveExecutable(plan.command, plan.env);
    const terminalStartedAt = performance.now();
    const useBuiltinSsh = platformAdapter.kind === 'windows'
      && Boolean(resolved.hostConfig.password)
      && !resolved.hostConfig.private_key_path;
    const terminal = useBuiltinSsh
      ? vscode.window.createTerminal({
        name: terminalName,
        pty: new Ssh2Terminal(
          context, resolved.hostConfig, resolved.hostConfig.password!, remoteCwd
        ),
        isTransient: true
      })
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

  // Clean up AI forwarding state
  const enabled = new Set(vscodeContext.globalState.get<string[]>(aiForwardMountsKey, []));
  enabled.delete(mount.name);
  await vscodeContext.globalState.update(aiForwardMountsKey, [...enabled]);
  if (enabled.size === 0) await mcp?.stop();
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

function toolPath(folder: RemoteFolder, value = '.'): string {
  const resolved = value.startsWith('/')
    ? path.posix.normalize(value)
    : path.posix.resolve(folder.remoteRoot, value);
  if (!isRemotePathInsideRoot(folder.remoteRoot, resolved)) {
    throw new Error(`路径超出远程工作区：${value}`);
  }
  return resolved;
}

async function remoteList(input: { mountName: string; path?: string }): Promise<unknown> {
  const { mount, folder } = await mountAndFolder(input.mountName);
  const remotePath = toolPath(folder, input.path);
  const uri = vscode.Uri.parse(remoteUri(folder.mountName, remotePath));
  return {
    mountName: mount.name,
    path: remotePath,
    entries: (await provider.readDirectory(uri)).map(([name, type]) => ({ name, type }))
  };
}

async function remoteRead(input: {
  mountName: string; path: string; offset?: number; length?: number;
}): Promise<unknown> {
  const { mount, folder } = await mountAndFolder(input.mountName);
  const remotePath = toolPath(folder, input.path);
  const bytes = await provider.readFile(
    vscode.Uri.parse(remoteUri(folder.mountName, remotePath))
  );
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
  const uri = vscode.Uri.parse(remoteUri(folder.mountName, remotePath));
  const content = new TextEncoder().encode(input.content);
  await provider.writeFile(uri, content, { create: true, overwrite: true });
  return { mountName: input.mountName, path: remotePath, bytes: content.length };
}

async function executeRemoteCommand(
  context: vscode.ExtensionContext, input: { command: string; mountName: string; remoteCwd?: string },
  token?: vscode.CancellationToken
): Promise<Record<string, unknown>> {
  if (!input.command?.trim()) throw new Error('Remote command must not be empty.');
  const { mount, folder } = await mountAndFolder(input.mountName);
  const requestedCwd = toolPath(folder, input.remoteCwd);
  const remoteCwd = await (await pool.get(mount.host)).realpath(requestedCwd);
  if (!isRemotePathInsideRoot(folder.remoteRoot, remoteCwd)) {
    throw new Error(`远程工作目录通过符号链接超出工作区：${requestedCwd}`);
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
    try {
      let result;
      if (platformAdapter.kind === 'windows') {
        bridgeOutput?.show(true);
        bridgeOutput?.appendLine(
          `[${new Date().toLocaleString()}] [Agent MCP] $ ${input.command} (cwd: ${remoteCwd})`
        );
        try {
          result = await executeSsh2Command(
            context, resolved.hostConfig, resolved.hostConfig.password,
            remoteCwd, input.command, controller.signal
          );
          if (result.stdout) bridgeOutput?.append(result.stdout);
          if (result.stderr) bridgeOutput?.append(result.stderr);
          bridgeOutput?.appendLine(
            `[Agent MCP] [${result.exitCode === 0 ? '完成' : `失败: exit ${result.exitCode}`}] ${input.command}`
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          bridgeOutput?.appendLine(`[Agent MCP] [失败] ${input.command}: ${detail}`);
          throw error;
        }
      } else {
        const plan = platformAdapter.exec(resolved.hostConfig, remoteCwd, input.command, {
          reuseSshConnection: settings().get<boolean>('reuseSshConnection', true)
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
  mountName: string; command: string; remoteCwd?: string;
}): Promise<unknown> {
  return executeRemoteCommand(vscodeContext, input);
}

async function remoteSearch(input: {
  mountName: string; query: string; path?: string;
}): Promise<unknown> {
  const { mount, folder } = await mountAndFolder(input.mountName);
  const requestedPath = toolPath(folder, input.path);
  const searchPath = await (await pool.get(mount.host)).realpath(requestedPath);
  if (!isRemotePathInsideRoot(folder.remoteRoot, searchPath)) {
    throw new Error(`搜索路径通过符号链接超出工作区：${requestedPath}`);
  }
  return executeRemoteCommand(vscodeContext, {
    mountName: input.mountName,
    remoteCwd: folder.remoteRoot,
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
    const connected = registry.get(mount.name) !== undefined;
    const aiForwarded = this.context.globalState
      .get<string[]>(aiForwardMountsKey, []).includes(mount.name);
    const item = new vscode.TreeItem(mount.name);
    item.description = connected
      ? (aiForwarded ? '已连接 SFTP · AI' : '已连接 SFTP')
      : (aiForwarded ? 'AI 转发已开启' : '未连接');
    item.contextValue = connected
      ? 'serverlessRemote.connection.connected'
      : 'serverlessRemote.connection';
    item.iconPath = new vscode.ThemeIcon(connected ? 'vm-active' : 'remote');
    item.tooltip = new vscode.MarkdownString([
      `**${mount.name}**`,
      '',
      `Host: \`${mount.host}\``,
      `Remote: \`${mount.remote_path}\``,
      '',
      connected ? '已连接 SFTP' : '未连接',
      aiForwarded ? 'AI 转发：已开启' : 'AI 转发：已关闭',
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
        'setContext', 'serverlessRemote.hasNoMounts', config.mounts.length === 0
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
    if (folder.remoteRoot !== location.remotePath) {
      output.appendLine(
        `远程根目录已变化：${location.remotePath} -> ${folder.remoteRoot}`
      );
    }
    if (mount.remote_terminal === 'open') {
      await openTerminal(vscodeContext, mount, location.remotePath);
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
    const location = parseRemoteUri(workspace.uri.toString());
    const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
    if (!mount) continue;
    registry.set({
      mountName: mount.name,
      hostName: mount.host,
      remoteRoot: location.remotePath
    });
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
        workspaceUri: remoteUri(folder.mountName, folder.remoteRoot),
        remoteRoot: folder.remoteRoot,
        host: mount.host
      };
    })
  );
}

async function ensureAgentMcpServer(context: vscode.ExtensionContext): Promise<AgentMcpServer> {
  if (!mcp) {
    let token = await context.secrets.get(agentMcpTokenSecret);
    if (!token) {
      token = randomBytes(24).toString('hex');
      await context.secrets.store(agentMcpTokenSecret, token);
    }
    mcp = new AgentMcpServer(
      settings().get<number>('agentMcpPort', 0)
        || defaultAgentMcpPort(platformAdapter.kind),
      token,
      {
        listFolders: () => forwardedFolders(context),
        currentWorkspace: async () => {
          const location = currentRemoteLocation();
          if (!location) return null;
          const config = await readConfig();
          const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
          if (!mount) return null;
          const folder = await ensureFolder(mount);
          return {
            name: mount.name,
            workspaceUri: remoteUri(folder.mountName, location.remotePath),
            remoteRoot: folder.remoteRoot,
            host: mount.host
          };
        },
        list: remoteList,
        read: remoteRead,
        write: remoteWrite,
        search: remoteSearch,
        run: (input) => executeRemoteCommand(context, input),
        log: (message) => bridgeOutput?.appendLine(`[Agent MCP] ${message}`)
      }
    );
    context.subscriptions.push({ dispose: () => void mcp?.stop() });
  }
  await mcp.start();
  return mcp;
}

async function detectedCodexCommand(): Promise<string | undefined> {
  if (await commandExists('codex')) return 'codex';
  const extension = vscode.extensions.getExtension('openai.chatgpt');
  if (!extension) return undefined;
  const binRoot = path.join(extension.extensionPath, 'bin');
  try {
    const platformDirectories = await readdir(binRoot, { withFileTypes: true });
    for (const directory of platformDirectories) {
      if (!directory.isDirectory()) continue;
      const candidate = path.join(
        binRoot, directory.name, process.platform === 'win32' ? 'codex.exe' : 'codex'
      );
      try {
        await access(candidate);
        bridgeOutput?.appendLine(`[Agent MCP] 使用 Codex 扩展内置 CLI：${candidate}`);
        return candidate;
      } catch {
        // Try the next platform directory.
      }
    }
  } catch {
    // The installed Codex extension does not expose a bundled CLI.
  }
  return undefined;
}

async function detectedClaudeCommand(): Promise<string | undefined> {
  if (await commandExists('claude')) return 'claude';
  const extension = vscode.extensions.getExtension('anthropic.claude-code');
  if (!extension) return undefined;
  const candidate = path.join(
    extension.extensionPath, 'resources', 'native-binary',
    process.platform === 'win32' ? 'claude.exe' : 'claude'
  );
  try {
    await access(candidate);
    bridgeOutput?.appendLine(`[Agent MCP] 使用 Claude Code 扩展内置 CLI：${candidate}`);
    return candidate;
  } catch {
    return undefined;
  }
}

async function configureDetectedAgents(
  context: vscode.ExtensionContext, server: AgentMcpServer
): Promise<void> {
  const saved = context.globalState.get<unknown>(agentSetupCompletedKey);
  const configured = new Set(Array.isArray(saved) ? saved.filter(
    (item): item is string => typeof item === 'string'
  ) : []);
  const [codexCommand, claudeCommand] = await Promise.all([
    detectedCodexCommand(), detectedClaudeCommand()
  ]);
  bridgeOutput?.appendLine(
    `[Agent MCP] Agent 检测：Codex ${codexCommand ? '可用' : '未找到'}，Claude Code ${
      claudeCommand ? '可用' : '未找到'
    }`
  );
  const [codexStatus, claudeStatus] = await Promise.all([
    codexCommand
      ? executeAgentMcpCommand({ command: codexCommand, args: ['mcp', 'get', 'serverless-remote'] })
      : Promise.resolve(undefined),
    claudeCommand
      ? executeAgentMcpCommand({ command: claudeCommand, args: ['mcp', 'get', 'serverless-remote'] })
      : Promise.resolve(undefined)
  ]);
  const codexConfigured = codexStatus?.exitCode === 0;
  const claudeConfigured = claudeStatus?.exitCode === 0;
  if (!codexConfigured) configured.delete('codex');
  if (!claudeConfigured) configured.delete('claude');
  bridgeOutput?.appendLine(
    `[Agent MCP] 注册状态：Codex ${codexConfigured ? '已注册' : '未注册'}，Claude Code ${
      claudeConfigured ? '已注册' : '未注册'
    }`
  );
  const agents = [
    ...(codexCommand && !codexConfigured ? ['Codex'] : []),
    ...(claudeCommand && !claudeConfigured ? ['Claude Code'] : [])
  ];
  if (agents.length === 0) {
    await context.globalState.update(agentSetupCompletedKey, [...configured]);
    return;
  }
  const configureAction = '一键配置';
  const selected = await vscode.window.showInformationMessage(
    `检测到 ${agents.join(' 和 ')}。是否注册 Serverless Remote SSH MCP？此操作只需一次。`,
    { modal: true, detail: `MCP 服务仅监听本机：${server.url.replace(/token=.*/, 'token=<hidden>')}` },
    configureAction
  );
  if (selected !== configureAction) {
    bridgeOutput?.appendLine('[Agent MCP] 用户取消了 Agent 自动配置');
    return;
  }
  const failures: string[] = [];
  if (codexCommand && !configured.has('codex')) {
    const result = await executeAgentMcpCommand({
      command: codexCommand,
      args: ['mcp', 'add', 'serverless-remote', '--url', server.url]
    });
    if (result.exitCode !== 0 && !/already exists/i.test(`${result.stdout}\n${result.stderr}`)) {
      failures.push(`Codex: ${result.stderr || result.stdout}`);
    } else {
      configured.add('codex');
      bridgeOutput?.appendLine('[Agent MCP] Codex 注册成功');
    }
  }
  if (claudeCommand && !configured.has('claude')) {
    const result = await executeAgentMcpCommand({
      command: claudeCommand,
      args: [
        'mcp', 'add', '--transport', 'http', '--scope', 'user',
        'serverless-remote', server.url
      ]
    });
    if (result.exitCode !== 0 && !/already exists/i.test(`${result.stdout}\n${result.stderr}`)) {
      failures.push(`Claude Code: ${result.stderr || result.stdout}`);
    } else {
      configured.add('claude');
      bridgeOutput?.appendLine('[Agent MCP] Claude Code 注册成功');
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
      await vscode.env.clipboard.writeText([
        codexCommand ? `codex mcp add serverless-remote --url '${server.url}'` : '',
        claudeCommand
          ? `claude mcp add --transport http --scope user serverless-remote '${server.url}'`
          : ''
      ].filter(Boolean).join('\n'));
    }
    return;
  }
  void vscode.window.showInformationMessage(
    `${agents.join(' 和 ')} 已配置。新打开的窗口会自动加载 MCP；如果 Agent 已在当前窗口运行，请重启对应 Agent/扩展。`
  );
}

async function maintainAgentGuidanceForMount(): Promise<void> {
  // For SFTP-backed workspaces, maintain guidance in the first remote workspace.
  const enabled = new Set(vscodeContext.globalState.get<string[]>(aiForwardMountsKey, []));
  if (enabled.size === 0) return;
  const config = await readConfig();
  for (const mount of config.mounts) {
    if (!enabled.has(mount.name)) continue;
    // Ensure the folder is reachable (side effect: initializes connection).
    await ensureFolder(mount);
    // Use the workspace URI from VS Code workspace state; if none open, skip.
    const workspace = vscode.workspace.workspaceFolders?.find(
      (f) => f.uri.scheme === remoteFileSystemScheme
    );
    if (!workspace) continue;
    const location = parseRemoteUri(workspace.uri.toString());
    if (location.mountName !== mount.name) continue;
    // In the SFTP model, guidance is maintained at the workspace level via agent-guidance.ts.
    // There is no local mount path for guidance injection. We use a home-directory
    // placeholder to detect the presence of AGENTS.md.
    const result = await maintainAgentGuidance(os.homedir());
    bridgeOutput?.appendLine(
      `[Agent MCP] ${result.changed ? '已更新' : '已确认'} Agent 指引：${result.filePath}`
    );
    return;
  }
}

async function toggleAiForward(mount: MountConfig): Promise<void> {
  const enabled = new Set(vscodeContext.globalState.get<string[]>(aiForwardMountsKey, []));
  const turningOn = !enabled.has(mount.name);
  if (turningOn) {
    // Ensure the folder is connected before enabling forwarding
    await ensureFolder(mount);
    enabled.add(mount.name);
  } else {
    enabled.delete(mount.name);
  }
  if (turningOn) {
    try {
      const server = await ensureAgentMcpServer(vscodeContext);
      await vscodeContext.globalState.update(aiForwardMountsKey, [...enabled]);
      await configureDetectedAgents(vscodeContext, server);
      await maintainAgentGuidanceForMount();
    } catch (error) {
      enabled.delete(mount.name);
      await vscodeContext.globalState.update(aiForwardMountsKey, [...enabled]);
      throw error;
    }
  } else if (enabled.size === 0) {
    await vscodeContext.globalState.update(aiForwardMountsKey, []);
    await mcp?.stop();
  } else {
    await vscodeContext.globalState.update(aiForwardMountsKey, [...enabled]);
  }
  void vscode.window.showInformationMessage(
    `"${mount.name}" AI 转发已${turningOn ? '打开' : '关闭'}。${
      turningOn ? 'Agent 的远程命令会自动映射到相同的远程工作目录。' : ''
    }`
  );
}

// ---- Guard / Error Handling (aligned with main) ----

async function guard(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ConfigActionRequiredError) {
      const selected = await vscode.window.showErrorMessage(
        `Serverless Remote SSH: ${message}`,
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
        `Serverless Remote SSH：找不到命令"${missingCommand}"，请确保 SSH 客户端已安装。`
      );
      return;
    }
    output.appendLine(`[错误] ${message}`);
    await vscode.window.showErrorMessage(`Serverless Remote SSH: ${message}`);
  }
}

// ---- Activate / Deactivate ----

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  vscodeContext = context;
  output = vscode.window.createOutputChannel('Serverless Remote SSH');
  bridgeOutput = vscode.window.createOutputChannel('Serverless Remote SSH');
  context.subscriptions.push(output, bridgeOutput);

  // WSL: point the bundled scripts at resources/wsl/
  setWslBundlePath(vscode.Uri.joinPath(context.extensionUri, 'resources', 'wsl').fsPath);

  registry = new RemoteFolderRegistry();
  pool = new SftpConnectionPool(async (hostName, signal) =>
    connectSftp(await resolvedHost(context, hostName), platformAdapter.kind === 'wsl', signal)
  );
  await guard(preloadRemoteWorkspaces);
  provider = new SftpFileSystemProvider(
    pool,
    registry,
    settings().get<number>('sftp.cacheTtl', 5) * 1000,
    settings().get<number>('sftp.watchInterval', 5) * 1000
  );

  const tree = new RemoteFoldersProvider(context);
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
  command('openFolder', () => openRemoteFolder());
  command('openFolderItem', (mount) => openRemoteFolder(mount));
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
  command('refreshExplorer', async () => tree.refresh());
  command('deleteConfigItem', async (mount) => {
    await deleteConfig(mount);
    tree.refresh();
  });
  command('toggleAiForwardItem', async (mount) => {
    await toggleAiForward(mount);
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
  tool('serverlessRemote_listRemoteFiles', remoteList);
  tool('serverlessRemote_readRemoteFile', remoteRead);
  tool('serverlessRemote_writeRemoteFile', remoteWrite, true);
  tool('serverlessRemote_searchRemoteFiles', remoteSearch);
  tool('serverlessRemote_runRemoteCommand', runRemote, true);

  // Terminal lifecycle
  context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
    void suggestReopeningClosedTerminal(terminal);
  }));

  // Restore workspaces on startup
  await guard(restoreRemoteWorkspaces);

  // Agent MCP: start and auto-configure on launch
  await guard(async () => {
    const enabled = new Set(context.globalState.get<string[]>(aiForwardMountsKey, []));
    if (enabled.size > 0) {
      const server = await ensureAgentMcpServer(context);
      if (!server.portUnavailable) {
        await configureDetectedAgents(context, server);
      }
      await maintainAgentGuidanceForMount();
    }
  });

  // Status bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.name = 'Serverless Remote SSH';
  statusBar.text = '$(remote) Serverless SFTP';
  statusBar.tooltip = '打开 SFTP 远程文件夹';
  statusBar.command = `${commandPrefix}.openFolder`;
  statusBar.show();
  context.subscriptions.push(statusBar);
}

export async function deactivate(): Promise<void> {
  await mcp?.stop();
  await pool?.close();
}
