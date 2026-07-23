import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import {
  BridgeConfig, ensureConfigFile, expandHome, HostConfig, loadConfig, MountConfig, RemoteTerminalMode,
  resolveMount, saveConfig
} from './config';
import { commandExists, commandSucceeds, executeWithStdin } from './process';
import { CommandPlan, createPlatformAdapter } from './platform';
import type { ResolvedMount } from './config';
import { decryptPassword, encryptPassword, isEncryptedPassword } from './password';
import { findMountForPath, findMountForPaths, remotePathForLocalPath } from './mount-path';
import {
  downloadInstaller, hasWindowsInstallDirectory, installMsiPackages, sshfsWinInstaller,
  winFspInstaller, WindowsInstaller
} from './windows-installer';
import { createDependencyGuide } from './dependency-guide';
import { AskpassCredentials, createAskpassCredentials, platformUsesAskpass } from './askpass';

const commandPrefix = 'serverlessRemote';
const platformAdapter = createPlatformAdapter();

interface PendingOpen {
  mountName: string;
  localPath: string;
  createdAt: number;
  ownsMount?: boolean;
}

interface PendingUnmount {
  mountName: string;
  localPath: string;
  createdAt: number;
}

const pendingOpenKey = 'serverlessRemote.pendingOpen';
const pendingUnmountKey = 'serverlessRemote.pendingUnmount';
const pendingOpenTtlMs = 5 * 60 * 1000;
const openConfigAction = 'Open Config';
const addSshConfigAction = 'Add SSH Config';
const addSshfsConfigAction = 'Add SSHFS Config';
const masterPasswordSecret = 'serverlessRemote.masterPassword';
const dismissedWindowsInstallKey = 'serverlessRemote.dismissedWindowsInstall';
const defaultNativeConfigPath = '~/serverless-remote-ssh/config.json';
const defaultWslConfigPath = '~/.wsl-vpn-ssh/config.json';
let bridgeOutput: vscode.OutputChannel | undefined;
const nativeSessionMounts = new Map<string, { remote: ResolvedMount; localPath: string }>();
let workspaceSwitchMountPath: string | undefined;

class ConfigActionRequiredError extends Error {
  constructor(message: string, readonly actions = [openConfigAction]) {
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
  const defaultPath = platformAdapter.kind === 'wsl' ? defaultWslConfigPath : defaultNativeConfigPath;
  return expandHome(configured ?? defaultPath);
}

async function readConfig(): Promise<BridgeConfig> {
  try {
    return await loadConfig(configPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigActionRequiredError(
        `No config file was found at ${configPath()}.`,
        [addSshConfigAction, addSshfsConfigAction]
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigActionRequiredError(`Cannot read ${configPath()}: ${message}`);
  }
}

async function selectMount(placeHolder: string): Promise<MountConfig | undefined> {
  const config = await readConfig();
  if (config.mounts.length === 0) {
    throw new ConfigActionRequiredError(
      'No remote folders are configured yet.',
      [addSshConfigAction, addSshfsConfigAction]
    );
  }
  const picked = await vscode.window.showQuickPick(
    config.mounts.map((mount) => ({
      label: mount.name,
      description: `${mount.host}: ${mount.remote_path}`,
      detail: mount.local_path ? expandHome(mount.local_path) : `${mount.remote_terminal ?? 'open'} mode`,
      mount
    })),
    { placeHolder, matchOnDescription: true, matchOnDetail: true }
  );
  return picked?.mount;
}

async function mountDirectory(mount: MountConfig): Promise<string | undefined> {
  const configuredPath = mount.local_paths?.[platformAdapter.kind] ?? mount.local_path;
  if (mount.remote_terminal !== 'now') {
    if (!configuredPath) {
      throw new Error(`Mount '${mount.name}' has no local_path`);
    }
    return expandHome(configuredPath);
  }
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: `Mount ${mount.name} here`,
    title: 'Choose the local directory for now mode'
  });
  return selected?.[0]?.fsPath;
}

async function executeTask(plan: CommandPlan): Promise<void> {
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  // A ProcessExecution without an explicit cwd can fall back to a user's
  // terminal.integrated.cwd setting. If that contains ${workspaceFolder}, VS
  // Code cannot resolve it while this extension is opening the first folder.
  const options = {
    cwd: plan.cwd ?? os.homedir(),
    env: { ...inheritedEnv, ...plan.env }
  };
  const execution = new vscode.ProcessExecution(plan.command, plan.args, options);
  const task = new vscode.Task(
    { type: 'serverlessRemote', command: plan.command, target: plan.args.at(-1) ?? '' },
    vscode.TaskScope.Global,
    `${plan.command} ${plan.args.join(' ')}`,
    'Serverless Remote SSH',
    execution
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    close: true,
    showReuseMessage: false
  };
  await vscode.tasks.executeTask(task);
}

async function executePlan(plan: CommandPlan): Promise<void> {
  if (plan.stdin !== undefined) {
    if (plan.command === 'sshfs-bridge' && bridgeOutput) {
      bridgeOutput.show(true);
      bridgeOutput.appendLine(`[${new Date().toLocaleString()}] $ ${plan.command} ${plan.args.join(' ')}`);
      try {
        await executeWithStdin(plan, {
          stdout: (chunk) => bridgeOutput?.append(chunk),
          stderr: (chunk) => bridgeOutput?.append(chunk)
        });
        bridgeOutput.appendLine(`[完成] ${plan.command} ${plan.args.join(' ')}`);
      } catch (error) {
        bridgeOutput.appendLine(`[失败] ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      return;
    }
    await executeWithStdin(plan);
    return;
  }
  await executeTask(plan);
}

async function waitForPlan(plan: CommandPlan, timeoutSeconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (await commandSucceeds(plan)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function promptMasterPassword(context: vscode.ExtensionContext, confirm: boolean): Promise<string> {
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

async function ensureMounted(
  context: vscode.ExtensionContext, mount: MountConfig, localPath: string
): Promise<boolean> {
  const config = await readConfig();
  const resolved = resolveMount(config, mount);
  const statusPlan = platformAdapter.status(resolved, localPath);
  if (!await commandSucceeds(statusPlan)) {
    let credentials: AskpassCredentials | undefined;
    try {
      if (
        platformAdapter.kind === 'windows' || platformUsesAskpass(platformAdapter.kind)
      ) {
        resolved.hostConfig = await resolveStoredHostPassword(context, config, resolved.hostConfig);
      }
      let mountPlan = platformAdapter.mount(resolved, localPath);
      if (
        platformUsesAskpass(platformAdapter.kind) && resolved.hostConfig.password
      ) {
        credentials = await createAskpassCredentials(resolved.hostConfig.password);
        mountPlan = { ...mountPlan, env: { ...mountPlan.env, ...credentials.env } };
      }
      await executePlan(mountPlan);
      const timeout = settings().get<number>('mountTimeout', 30);
      if (!await waitForPlan(statusPlan, timeout)) {
        throw new Error(`Timed out waiting for mount: ${localPath}. Check the task terminal for details.`);
      }
      if (platformAdapter.kind === 'macos' || platformAdapter.kind === 'linux') {
        nativeSessionMounts.set(path.resolve(localPath), { remote: resolved, localPath });
      }
      return true;
    } finally {
      await credentials?.cleanup();
    }
  }
  return false;
}

async function mount(context: vscode.ExtensionContext, mountConfig?: MountConfig): Promise<string | undefined> {
  const mount = mountConfig ?? await selectMount('Select a remote folder to mount');
  if (!mount) {
    return undefined;
  }
  const localPath = await mountDirectory(mount);
  if (!localPath) {
    return undefined;
  }
  await ensureMounted(context, mount, localPath);
  void vscode.window.showInformationMessage(`${mount.name} mounted at ${localPath}`);
  return localPath;
}

async function openRemoteFolder(context: vscode.ExtensionContext): Promise<void> {
  const mount = await selectMount('Select a remote folder to open');
  if (!mount) return;
  const localPath = await mountDirectory(mount);
  if (!localPath) return;
  const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (current && sameLocalPath(current, localPath)) {
    await ensureMounted(context, mount, localPath);
    await openTerminal(context, mount, localPath);
    return;
  }
  const ownsMount = await ensureMounted(context, mount, localPath);
  await context.globalState.update(pendingOpenKey, {
    mountName: mount.name, localPath, createdAt: Date.now(), ownsMount
  });
  workspaceSwitchMountPath = path.resolve(localPath);
  try {
    const opened = await vscode.commands.executeCommand<boolean | undefined>(
      'vscode.openFolder', vscode.Uri.file(localPath), false
    );
    if (opened === false) {
      workspaceSwitchMountPath = undefined;
      await context.globalState.update(pendingOpenKey, undefined);
    }
  } catch (error) {
    workspaceSwitchMountPath = undefined;
    await context.globalState.update(pendingOpenKey, undefined);
    throw error;
  }
}

function sameLocalPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return platformAdapter.kind === 'windows'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function resumePendingOpen(context: vscode.ExtensionContext): Promise<void> {
  const pending = context.globalState.get<PendingOpen>(pendingOpenKey);
  if (!pending) return;
  if (!pending.createdAt || Date.now() - pending.createdAt > pendingOpenTtlMs) {
    await context.globalState.update(pendingOpenKey, undefined);
    return;
  }
  const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!current || !sameLocalPath(current, pending.localPath)) return;
  await context.globalState.update(pendingOpenKey, undefined);
  const config = await readConfig();
  const mount = config.mounts.find((item) => item.name === pending.mountName);
  if (!mount) throw new Error(`Pending mount no longer exists: ${pending.mountName}`);
  if (pending.ownsMount && (platformAdapter.kind === 'macos' || platformAdapter.kind === 'linux')) {
    nativeSessionMounts.set(path.resolve(pending.localPath), {
      remote: resolveMount(config, mount),
      localPath: pending.localPath
    });
  }
  await openTerminal(context, mount, pending.localPath);
}

async function openTerminal(
  context: vscode.ExtensionContext, mountConfig?: MountConfig, cwd?: string
): Promise<void> {
  let mount = mountConfig;
  if (!mount) {
    const config = await readConfig();
    const currentPath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
      ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const match = currentPath
      ? findMountForPath(config.mounts, currentPath, platformAdapter.kind, expandHome)
      : undefined;
    mount = match?.mount;
    cwd = match?.cwd;
  }
  mount ??= await selectMount('Select a remote terminal');
  if (!mount) {
    return;
  }
  const terminalName = `SSH: ${mount.name}`;
  const existingTerminal = vscode.window.terminals.find((terminal) => terminal.name === terminalName);
  if (existingTerminal) {
    existingTerminal.show();
    return;
  }
  const config = await readConfig();
  const resolved = resolveMount(config, mount);
  const configuredLocalPath = mount.local_paths?.[platformAdapter.kind] ?? mount.local_path;
  const localRoot = configuredLocalPath ? expandHome(configuredLocalPath) : undefined;
  const localCwd = cwd ?? localRoot;
  const remoteCwd = platformAdapter.kind !== 'wsl' && localRoot && localCwd
    ? remotePathForLocalPath(mount.remote_path, localRoot, localCwd, platformAdapter.kind)
    : undefined;
  let credentials: AskpassCredentials | undefined;
  if (platformUsesAskpass(platformAdapter.kind)) {
    resolved.hostConfig = await resolveStoredHostPassword(context, config, resolved.hostConfig);
    if (resolved.hostConfig.password) {
      credentials = await createAskpassCredentials(resolved.hostConfig.password);
    }
  }
  const plan = platformAdapter.terminal(resolved.hostConfig, remoteCwd);
  const terminal = vscode.window.createTerminal({
    name: terminalName,
    shellPath: plan.command,
    shellArgs: plan.args,
    env: { SSH_BRIDGE_MOUNT_NAME: mount.name, ...credentials?.env },
    cwd: localCwd,
    isTransient: true
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
    }, pendingOpenTtlMs);
  }
  terminal.show();
}

async function autoOpenWorkspaceTerminal(context: vscode.ExtensionContext): Promise<void> {
  const workspacePaths = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  if (workspacePaths.length === 0) return;
  let config: BridgeConfig;
  try {
    config = await loadConfig(configPath());
  } catch {
    return;
  }
  const activePath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
    ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)
    : undefined;
  const candidates = activePath ? [activePath, ...workspacePaths] : workspacePaths;
  const match = findMountForPaths(config.mounts, candidates, platformAdapter.kind, expandHome);
  if (!match || (match.mount.remote_terminal ?? 'open') !== 'open') return;
  await openTerminal(context, match.mount, match.cwd);
}

function workspaceUsesPath(localPath: string): boolean {
  const mountPath = path.resolve(localPath);
  return vscode.workspace.workspaceFolders?.some((folder) => {
    const workspacePath = path.resolve(folder.uri.fsPath);
    const relative = path.relative(mountPath, workspacePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }) ?? false;
}

async function executeUnmount(mount: MountConfig, localPath: string): Promise<void> {
  let disposedTaskTerminal = false;
  for (const terminal of vscode.window.terminals) {
    if (terminal.name.includes('sshfs-bridge mount ')) {
      terminal.dispose();
      disposedTaskTerminal = true;
    }
  }
  if (disposedTaskTerminal) await new Promise((resolve) => setTimeout(resolve, 300));
  const config = await readConfig();
  await executePlan(platformAdapter.unmount(resolveMount(config, mount), localPath));
  nativeSessionMounts.delete(path.resolve(localPath));
}

async function unmount(context: vscode.ExtensionContext): Promise<void> {
  const mount = await selectMount('Select a remote folder to unmount');
  if (mount) {
    const localPath = mount.local_paths?.[platformAdapter.kind] ?? mount.local_path;
    if (!localPath) throw new Error(`Mount '${mount.name}' has no recorded local_path`);
    const expandedPath = expandHome(localPath);
    if (workspaceUsesPath(expandedPath)) {
      await context.globalState.update(pendingUnmountKey, {
        mountName: mount.name, localPath: expandedPath, createdAt: Date.now()
      } satisfies PendingUnmount);
      await vscode.commands.executeCommand('workbench.action.closeFolder');
      return;
    }
    await executeUnmount(mount, expandedPath);
  }
}

async function relayStatusLines(): Promise<string[]> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const runtimeRoot = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  const poolPath = path.join(runtimeRoot, `vpn-relay-pool-${uid ?? 'unknown'}`);
  try {
    const stateFiles = (await readdir(poolPath)).filter((name) => name.endsWith('.state'));
    const lines = await Promise.all(stateFiles.map(async (name) => {
      const [pid, port, host, targetPort] = (await readFile(path.join(poolPath, name), 'utf8')).trim().split('\n');
      return `  registered: 127.0.0.1:${port} -> ${host}:${targetPort} (Windows PID ${pid})`;
    }));
    return lines.length ? lines : ['  no registered relays'];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? ['  no registered relays'] : [`  unavailable: ${String(error)}`];
  }
}

async function showStatus(output: vscode.OutputChannel): Promise<void> {
  const config = await readConfig();
  output.clear();
  output.appendLine('Mounts');
  for (const mount of config.mounts) {
    const localPath = mount.local_paths?.[platformAdapter.kind] ?? mount.local_path;
    if (!localPath) {
      output.appendLine(`  ${mount.name}: not configured for ${platformAdapter.kind}`);
      continue;
    }
    const expandedPath = expandHome(localPath);
    const mounted = await commandSucceeds(platformAdapter.status(resolveMount(config, mount), expandedPath));
    output.appendLine(`  ${mount.name}: ${mounted ? 'mounted' : 'not mounted'} (${expandedPath})`);
  }
  if (platformAdapter.kind === 'wsl') {
    output.appendLine('');
    output.appendLine('Relay');
    for (const line of await relayStatusLines()) output.appendLine(line);
  }
  output.show(true);
}

async function resumePendingUnmount(context: vscode.ExtensionContext): Promise<void> {
  const pending = context.globalState.get<PendingUnmount>(pendingUnmountKey);
  if (!pending) return;
  if (!pending.createdAt || Date.now() - pending.createdAt > pendingOpenTtlMs) {
    await context.globalState.update(pendingUnmountKey, undefined);
    return;
  }
  if (workspaceUsesPath(pending.localPath)) return;
  const config = await readConfig();
  const mount = config.mounts.find((item) => item.name === pending.mountName);
  await context.globalState.update(pendingUnmountKey, undefined);
  if (!mount) throw new Error(`Pending unmount no longer exists: ${pending.mountName}`);
  await executeUnmount(mount, pending.localPath);
}

async function openConfig(): Promise<void> {
  const resolvedPath = await ensureConfigFile(configPath());
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedPath));
  await vscode.window.showTextDocument(document);
}

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

async function editableConfig(): Promise<BridgeConfig> {
  await ensureConfigFile(configPath());
  const config = await loadConfig(configPath());
  config.encrypt_passwords = true;
  return config;
}

async function confirmReplacement(kind: string, name: string, exists: boolean): Promise<boolean> {
  if (!exists) return true;
  return await vscode.window.showWarningMessage(
    `${kind} 配置“${name}”已存在，是否覆盖？`,
    { modal: true },
    '覆盖'
  ) === '覆盖';
}

async function addSshConfig(context: vscode.ExtensionContext): Promise<void> {
  const title = 'Add SSH Config';
  const name = await input({
    title, prompt: '配置名称（供 SSHFS 配置引用）', value: 'dev', validateInput: required('配置名称')
  });
  if (name === undefined) return;
  const ip = await input({
    title, prompt: '服务器 IP 地址或主机名', value: '10.0.0.2', validateInput: required('服务器地址')
  });
  if (ip === undefined) return;
  const user = await input({
    title, prompt: 'SSH 登录用户名', value: os.userInfo().username, validateInput: required('用户名')
  });
  if (user === undefined) return;
  const password = await input({
    title, prompt: 'SSH 密码（可选，推荐使用私钥；保存前使用主口令加密）',
    placeHolder: '留空则不保存密码', password: true
  });
  if (password === undefined) return;
  const privateKeyPath = await input({
    title, prompt: 'SSH 私钥路径（可选）', placeHolder: '例如 ~/.ssh/id_ed25519'
  });
  if (privateKeyPath === undefined) return;
  const portText = await input({
    title, prompt: 'SSH 端口', value: '22',
    validateInput: (value) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535
      ? undefined : '端口必须是 1–65535 的整数'
  });
  if (portText === undefined) return;
  let vpn: boolean | undefined;
  if (platformAdapter.kind !== 'macos' && platformAdapter.kind !== 'linux') {
    const selectedVpn = await vscode.window.showQuickPick([
      { label: 'Yes', description: '使用 VPN 中继（默认）', value: true },
      { label: 'No', description: '直接连接服务器', value: false }
    ], { title, placeHolder: '是否使用 VPN 中继？', ignoreFocusOut: true });
    if (!selectedVpn) return;
    vpn = selectedVpn.value;
  }

  const config = await editableConfig();
  const normalizedName = name.trim();
  const existingIndex = config.hosts.findIndex((host) => host.name === normalizedName);
  if (!await confirmReplacement('SSH', normalizedName, existingIndex >= 0)) return;
  const host: HostConfig = {
    name: normalizedName,
    ip: ip.trim(),
    user: user.trim(),
    port: Number(portText)
  };
  if (vpn !== undefined) host.vpn = vpn;
  if (privateKeyPath.trim()) host.private_key_path = privateKeyPath.trim();
  if (password) {
    const masterPassword = await promptMasterPassword(context, true);
    host.password = await encryptPassword(password, masterPassword);
  }
  if (existingIndex >= 0) config.hosts[existingIndex] = host;
  else config.hosts.push(host);
  config.encrypt_passwords = true;
  await saveConfig(configPath(), config);
  void vscode.window.showInformationMessage(`已保存 SSH 配置“${normalizedName}”`);
}

async function addSshfsConfig(): Promise<void> {
  const title = 'Add SSHFS Config';
  const config = await editableConfig();
  if (config.hosts.length === 0) {
    const selected = await vscode.window.showWarningMessage('请先添加 SSH 配置。', 'Add SSH Config');
    if (selected === 'Add SSH Config') await vscode.commands.executeCommand(`${commandPrefix}.addSshConfig`);
    return;
  }
  const name = await input({
    title, prompt: 'SSHFS 配置名称', value: 'project', validateInput: required('配置名称')
  });
  if (name === undefined) return;
  const host = await vscode.window.showQuickPick(
    config.hosts.map((item) => ({
      label: item.name, description: `${item.user}@${item.ip}:${item.port ?? 22}`, host: item.name
    })),
    { title, placeHolder: '选择引用的 SSH 配置', ignoreFocusOut: true }
  );
  if (!host) return;
  const remotePath = await input({
    title, prompt: '服务器上的远程目录', value: `/home/${config.hosts.find((item) => item.name === host.host)?.user ?? 'user'}`,
    validateInput: required('远程目录')
  });
  if (remotePath === undefined) return;
  const mode = await vscode.window.showQuickPick([
    { label: 'open', description: '进入挂载目录时打开远程终端（默认）', value: 'open' as const },
    { label: 'now', description: '挂载时临时选择本地目录并打开终端', value: 'now' as const },
    { label: 'never', description: '不自动打开远程终端', value: 'never' as const }
  ], { title, placeHolder: '选择远程终端方式', ignoreFocusOut: true });
  if (!mode) return;

  let localPath: string | undefined;
  if (mode.value !== 'now') {
    const basePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    localPath = await input({
      title, prompt: '本地 SSHFS 挂载目录', value: path.join(basePath, name.trim()),
      validateInput: required('本地挂载目录')
    });
    if (localPath === undefined) return;
  }

  const normalizedName = name.trim();
  const existingIndex = config.mounts.findIndex((mount) => mount.name === normalizedName);
  if (!await confirmReplacement('SSHFS', normalizedName, existingIndex >= 0)) return;
  const mount: MountConfig = {
    name: normalizedName,
    host: host.host,
    remote_path: remotePath.trim(),
    remote_terminal: mode.value as RemoteTerminalMode
  };
  if (localPath) mount.local_path = localPath.trim();
  if (existingIndex >= 0) config.mounts[existingIndex] = mount;
  else config.mounts.push(mount);
  await saveConfig(configPath(), config);
  if (localPath) await mkdir(expandHome(localPath), { recursive: true });
  void vscode.window.showInformationMessage(`已保存 SSHFS 配置“${normalizedName}”`);
}

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
        await vscode.commands.executeCommand(`${commandPrefix}.openConfig`);
      } else if (selected === addSshConfigAction) {
        await vscode.commands.executeCommand(`${commandPrefix}.addSshConfig`);
      } else if (selected === addSshfsConfigAction) {
        await vscode.commands.executeCommand(`${commandPrefix}.addSshfsConfig`);
      }
      return;
    }
    await vscode.window.showErrorMessage(`Serverless Remote SSH: ${message}`);
  }
}

async function offerWindowsDependencyInstall(
  context: vscode.ExtensionContext, force = false
): Promise<void> {
  if (platformAdapter.kind !== 'windows') return;
  const missing: WindowsInstaller[] = [];
  const missingCommands: string[] = [];
  const hasWinFsp = await commandExists('fsptool-x64.exe') || await hasWindowsInstallDirectory('WinFsp');
  if (!hasWinFsp) {
    missing.push(winFspInstaller);
    missingCommands.push('fsptool-x64.exe');
  }
  const hasSshfsWin = await commandExists('sshfs-win.exe') || await hasWindowsInstallDirectory('SSHFS-Win');
  if (!hasSshfsWin) {
    missing.push(sshfsWinInstaller);
    missingCommands.push('sshfs-win.exe');
  }
  if (missing.length === 0) {
    if (force) void vscode.window.showInformationMessage('WinFsp 和 SSHFS-Win 均已安装。');
    return;
  }
  const fingerprint = missingCommands.join('|');
  if (!force && context.globalState.get<string>(dismissedWindowsInstallKey) === fingerprint) return;

  const installAction = '下载并安装';
  const selected = await vscode.window.showWarningMessage(
    `Serverless Remote SSH 缺少：${missing.map((item) => item.name).join('、')}。是否从官方 GitHub 下载并安装？`,
    { modal: true, detail: '安装程序将校验 SHA-256，并请求 Windows 管理员权限。' },
    installAction
  );
  if (selected !== installAction) {
    await context.globalState.update(dismissedWindowsInstallKey, fingerprint);
    return;
  }

  const paths = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: '正在下载 Serverless Remote SSH 的 Windows 依赖',
    cancellable: false
  }, async (progress) => {
    const downloaded: string[] = [];
    for (let index = 0; index < missing.length; index++) {
      const installer = missing[index];
      progress.report({
        message: installer.name,
        increment: index === 0 ? 0 : 100 / missing.length
      });
      downloaded.push(await downloadInstaller(installer, context.globalStorageUri.fsPath));
    }
    return downloaded;
  });
  await installMsiPackages(paths);
  await context.globalState.update(dismissedWindowsInstallKey, undefined);
  const reload = await vscode.window.showInformationMessage(
    'Windows 依赖安装完成。请重载 VS Code 后继续。',
    '重载窗口'
  );
  if (reload === '重载窗口') await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const missing = [];
  for (const command of platformAdapter.dependencies()) {
    if (platformAdapter.kind === 'windows' && command === 'sshfs-win.exe') continue;
    if (!await commandExists(command)) {
      missing.push(command);
    }
  }
  if (missing.length) {
    if (platformAdapter.kind === 'windows') {
      void vscode.window.showWarningMessage(`Serverless Remote SSH requires: ${missing.join(', ')}`);
    } else {
      const guide = await createDependencyGuide(platformAdapter.kind, missing);
      if (guide) {
        const copyAction = guide.command ? '复制安装命令' : undefined;
        const docsAction = guide.url ? '查看安装说明' : undefined;
        const actions = [copyAction, docsAction].filter((item): item is string => item !== undefined);
        const selected = await vscode.window.showWarningMessage(guide.message, ...actions);
        if (selected === copyAction && guide.command) {
          await vscode.env.clipboard.writeText(guide.command);
          void vscode.window.showInformationMessage('安装命令已复制到剪贴板，请在终端中运行。');
        } else if (selected === docsAction && guide.url) {
          await vscode.env.openExternal(vscode.Uri.parse(guide.url));
        }
      }
    }
  }
  await guard(() => offerWindowsDependencyInstall(context));

  const statusOutput = vscode.window.createOutputChannel('Serverless Remote SSH Status');
  bridgeOutput = vscode.window.createOutputChannel('Serverless Remote SSH');
  context.subscriptions.push(statusOutput, bridgeOutput);
  const registrations: Array<[string, () => Promise<void>]> = [
    ['openFolder', () => guard(() => openRemoteFolder(context))],
    ['openTerminal', () => guard(() => openTerminal(context))],
    ['mount', () => guard(() => mount(context))],
    ['unmount', () => guard(() => unmount(context))],
    ['status', () => guard(() => showStatus(statusOutput))],
    ['openConfig', () => guard(openConfig)],
    ['addSshConfig', () => guard(() => addSshConfig(context))],
    ['addSshfsConfig', () => guard(addSshfsConfig)],
    ['installWindowsDependencies', () => guard(() => offerWindowsDependencyInstall(context, true))]
  ];
  for (const [name, handler] of registrations) {
    context.subscriptions.push(vscode.commands.registerCommand(`${commandPrefix}.${name}`, handler));
  }
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void guard(() => autoOpenWorkspaceTerminal(context));
  }));

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.name = 'Serverless Remote SSH';
  statusBar.text = '$(remote) Serverless SSH';
  statusBar.tooltip = 'Open an SSHFS-backed remote folder';
  statusBar.command = `${commandPrefix}.openFolder`;
  statusBar.show();
  context.subscriptions.push(statusBar);
  await guard(() => resumePendingUnmount(context));
  await guard(() => resumePendingOpen(context));
  await guard(() => autoOpenWorkspaceTerminal(context));
}

export async function deactivate(): Promise<void> {
  if (platformAdapter.kind !== 'macos' && platformAdapter.kind !== 'linux') return;
  const mounts = [...nativeSessionMounts.entries()]
    .filter(([mountPath]) => mountPath !== workspaceSwitchMountPath)
    .map(([, mount]) => mount);
  nativeSessionMounts.clear();
  await Promise.allSettled(mounts.map(async ({ remote, localPath }) => {
    const statusPlan = platformAdapter.status(remote, localPath);
    if (!await commandSucceeds(statusPlan)) return;
    await commandSucceeds(platformAdapter.unmount(remote, localPath));
  }));
}
