import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import {
  BridgeConfig, ensureConfigFile, expandHome, HostConfig, loadConfig, MountConfig,
  parseSshLogin, resolveMount, saveConfig, setMountLocalPath
} from './config';
import { commandExists, commandSucceeds, executeWithStdin } from './process';
import { CommandPlan, ConnectionOptions, createPlatformAdapter } from './platform';
import type { ResolvedMount } from './config';
import { decryptPassword, encryptPassword, isEncryptedPassword } from './password';
import {
  defaultMountDirectory, findMountForPath, findMountForPaths, remotePathForLocalPath,
  resolveMountDirectory
} from './mount-path';
import { MountOperationLock, normalizeMountLockKey } from './mount-lock';
import { hasWindowsInstallDirectory } from './windows-installer';
import { createDependencyGuide } from './dependency-guide';
import { AskpassCredentials, createAskpassCredentials, platformUsesAskpass } from './askpass';
import {
  isAuthenticationFailure, isNetworkFailure, passwordValueOffset
} from './authentication';
import { isEmptyDirectory, isEmptyDirectoryTree } from './directory';

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

interface RemoteMountTreeItem {
  mountName: string;
}

const pendingOpenKey = 'serverlessRemote.pendingOpen';
const pendingUnmountKey = 'serverlessRemote.pendingUnmount';
const pendingOpenTtlMs = 5 * 60 * 1000;
const openConfigAction = 'Open Config';
const addSshConfigAction = 'Add SSH Config';
const openRemoteTerminalAction = 'Open Remote Terminal';
const confirmMountAction = '确认挂载';
const chooseMountDirectoryAction = '选择其他本地目录';
const masterPasswordSecret = 'serverlessRemote.masterPassword';
const defaultNativeConfigPath = '~/serverless-remote-ssh/config.json';
const defaultWslConfigPath = '~/.wsl-vpn-ssh/config.json';
const terminalIdentityEnv = 'SERVERLESS_REMOTE_TERMINAL_ID';
const dependencyCacheKey = 'serverlessRemote.dependencyCache';
let bridgeOutput: vscode.OutputChannel | undefined;
const nativeSessionMounts = new Map<string, { remote: ResolvedMount; localPath: string }>();
const openingTerminalIds = new Set<string>();
let workspaceSwitchMountPath: string | undefined;
const mountOperations = new MountOperationLock();
const cachedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
);

function withMountLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const caseInsensitive = platformAdapter.kind === 'windows' || platformAdapter.kind === 'macos';
  return mountOperations.run(normalizeMountLockKey(key, caseInsensitive), action);
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

function connectionOptions(): ConnectionOptions {
  return {
    reuseSshConnection: settings().get<boolean>('reuseSshConnection', true)
      && platformAdapter.kind !== 'windows',
    sshfsCacheProfile: settings().get<'fresh' | 'balanced' | 'fast'>(
      'sshfsCacheProfile', 'balanced'
    )
  };
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
        [addSshConfigAction]
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigActionRequiredError(`Cannot read ${configPath()}: ${message}`);
  }
}

async function selectMount(placeHolder: string): Promise<{ mount: MountConfig; config: BridgeConfig } | undefined> {
  const config = await readConfig();
  if (config.mounts.length === 0) {
    throw new ConfigActionRequiredError(
      'No remote folders are configured yet.',
      [addSshConfigAction]
    );
  }
  const picked = await vscode.window.showQuickPick(
    config.mounts.map((mount) => ({
      label: mount.name,
      description: `${mount.host}: ${mount.remote_path}`,
      detail: mount.local_path ? expandHome(mount.local_path) : 'Uses the platform default mount path',
      mount
    })),
    { placeHolder, matchOnDescription: true, matchOnDetail: true }
  );
  return picked ? { mount: picked.mount, config } : undefined;
}

async function mountDirectory(mount: MountConfig): Promise<string | undefined> {
  const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return resolveMountDirectory(mount, current, platformAdapter.kind, expandHome);
}

async function confirmMountDirectory(localPath: string): Promise<string | undefined> {
  const selected = await vscode.window.showInformationMessage(
    `远程目录将挂载到：\n${localPath}`,
    { modal: true, detail: '确认使用该目录，或选择另一个本地目录作为本次挂载位置。' },
    confirmMountAction,
    chooseMountDirectoryAction
  );
  if (selected === confirmMountAction) return localPath;
  if (selected !== chooseMountDirectoryAction) return undefined;
  const picked = await vscode.window.showOpenDialog({
    title: '选择本地挂载目录',
    defaultUri: vscode.Uri.file(path.dirname(localPath)),
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '使用此目录'
  });
  return picked?.[0]?.fsPath;
}

async function executeTask(plan: CommandPlan): Promise<void> {
  const inheritedEnv = cachedEnv;
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
  let endListener: vscode.Disposable | undefined;
  const ended = new Promise<number | undefined>((resolve) => {
    endListener = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task === task) {
        endListener?.dispose();
        resolve(event.exitCode);
      }
    });
  });
  try {
    await vscode.tasks.executeTask(task);
  } catch (error) {
    endListener?.dispose();
    throw error;
  }
  const exitCode = await ended;
  if (exitCode !== 0) {
    throw new Error(`${plan.command} exited with code ${exitCode ?? 'unknown'}`);
  }
}

async function executePlan(plan: CommandPlan): Promise<void> {
  if (plan.stdin !== undefined) {
    if (plan.command === 'sshfs-bridge' && bridgeOutput) {
      bridgeOutput.show(true);
      bridgeOutput.appendLine(`[${new Date().toLocaleString()}] $ ${plan.command} ${plan.args.join(' ')}`);
      let emittedOutput = false;
      try {
        await executeWithStdin(plan, {
          stdout: (chunk) => {
            emittedOutput = true;
            bridgeOutput?.append(chunk);
          },
          stderr: (chunk) => {
            emittedOutput = true;
            bridgeOutput?.append(chunk);
          }
        });
        bridgeOutput.appendLine(`[完成] ${plan.command} ${plan.args.join(' ')}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        bridgeOutput.appendLine(emittedOutput ? '[失败]' : `[失败] ${detail}`);
        throw error;
      }
      return;
    }
    await executeWithStdin(plan);
    return;
  }
  await executeTask(plan);
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

interface EnsureMountedOptions {
  config?: BridgeConfig;
  knownUnmounted?: boolean;
}

async function ensureMountedUnlocked(
  context: vscode.ExtensionContext, mount: MountConfig, localPath: string,
  options: EnsureMountedOptions = {}
): Promise<boolean> {
  const config = options.config ?? await readConfig();
  const resolved = resolveMount(config, mount);
  const statusPlan = platformAdapter.status(resolved, localPath);
  const mounted = options.knownUnmounted === true
    ? false
    : await timedPhase(
      `${mount.name} 挂载状态检查`,
      () => commandSucceeds(statusPlan)
    );
  if (!mounted) {
    let credentials: AskpassCredentials | undefined;
    const connectionFailure = async (clearPassword: boolean): Promise<ConfigActionRequiredError> => {
      const hostIndex = config.hosts.findIndex((host) => host.name === resolved.hostConfig.name);
      if (clearPassword && hostIndex >= 0 && config.hosts[hostIndex].password) {
        config.hosts[hostIndex] = { ...config.hosts[hostIndex], password: '' };
        await saveConfig(configPath(), config);
      }
      return new ConfigActionRequiredError(
        `主机“${resolved.hostConfig.name}”网络连接失败或者密码错误，请打开配置设置新密码。`,
        [openConfigAction],
        resolved.hostConfig.name
      );
    };
    try {
      if (resolved.hostConfig.password) {
        resolved.hostConfig = await timedPhase(
          `${mount.name} 凭据准备`,
          () => resolveStoredHostPassword(context, config, resolved.hostConfig)
        );
      }
      let mountPlan = platformAdapter.mount(resolved, localPath, connectionOptions());
      if (platformAdapter.kind === 'wsl') {
        mountPlan = {
          ...mountPlan,
          env: {
            ...mountPlan.env,
            ...await bridgeMasterPasswordEnv(context, resolved.hostConfig)
          }
        };
      }
      if (
        platformUsesAskpass(platformAdapter.kind) && resolved.hostConfig.password
      ) {
        credentials = await createAskpassCredentials(resolved.hostConfig.password!);
        mountPlan = {
          ...mountPlan,
          env: { ...mountPlan.env, ...credentials.env },
          // Waiting for sshfs lets its own authentication/network errors reach
          // the extension.
          stdin: ''
        };
      }
      try {
        await timedPhase(`${mount.name} SSHFS 挂载`, () => executePlan(mountPlan));
      } catch (error) {
        const authenticationFailed = Boolean(
          resolved.hostConfig.password && isAuthenticationFailure(error)
        );
        if (!authenticationFailed && !isNetworkFailure(error)) throw error;
        throw await connectionFailure(authenticationFailed);
      }
      if (!await timedPhase(
        `${mount.name} 挂载结果验证`,
        () => commandSucceeds(statusPlan)
      )) {
        throw await connectionFailure(false);
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

async function openRemoteFolder(
  context: vscode.ExtensionContext, requestedMount?: MountConfig
): Promise<void> {
  const selected = requestedMount
    ? await (async () => {
        const config = await readConfig();
        const mount = config.mounts.find((candidate) => candidate.name === requestedMount.name);
        if (!mount) throw new Error(`Remote folder no longer exists: ${requestedMount.name}`);
        return { mount, config };
      })()
    : await selectMount('Select a remote folder to open');
  if (!selected) return;
  const { mount, config } = selected;
  const resolvedLocalPath = await mountDirectory(mount);
  if (!resolvedLocalPath) return;
  const localPath = await confirmMountDirectory(resolvedLocalPath);
  if (!localPath) return;
  if (!sameLocalPath(localPath, resolvedLocalPath)) {
    setMountLocalPath(config, mount.name, platformAdapter.kind, localPath);
    await saveConfig(configPath(), config);
  }
  if (platformAdapter.kind !== 'windows') await mkdir(localPath, { recursive: true });
  const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  await withMountLock(localPath, async () => {
    if (current && sameLocalPath(current, localPath)) {
      await ensureMountedUnlocked(context, mount, localPath, { config });
      await openTerminal(context, mount, localPath, config);
      return;
    }
    const ownsMount = await ensureMountedUnlocked(context, mount, localPath, { config });
    // VS Code can reconnect a terminal across vscode.openFolder even when it was
    // created as transient. Once ssh-bridge execs sshpass, the revived terminal's
    // title no longer matches "SSH: <mount>", so startup auto-connect would open
    // a second terminal. Close this mount's bridge terminal before switching;
    // resumePendingOpen creates exactly one terminal in the destination window.
    const host = resolveMount(config, mount).hostConfig;
    for (const terminal of vscode.window.terminals) {
      if (isBridgeTerminalForMount(terminal, mount.name, host.name)) {
        terminal.dispose();
      }
    }
    await context.globalState.update(pendingOpenKey, {
      mountName: mount.name, localPath, createdAt: Date.now(), ownsMount
    });
    const absoluteLocalPath = path.resolve(localPath);
    workspaceSwitchMountPath = absoluteLocalPath;
    try {
      const opened = await vscode.commands.executeCommand<boolean | undefined>(
        'vscode.openFolder',
        vscode.Uri.file(absoluteLocalPath),
        true
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
  });
}

function sameLocalPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return platformAdapter.kind === 'windows' || platformAdapter.kind === 'macos'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isBridgeTerminalForMount(
  terminal: vscode.Terminal, mountName: string, hostName: string
): boolean {
  const options = terminal.creationOptions;
  if (!('shellPath' in options)) return false;
  const identity = options.env?.[terminalIdentityEnv];
  if (identity?.startsWith(`${mountName}\0`)) return true;
  const configuredMount = options.env?.SSH_BRIDGE_MOUNT_NAME;
  if (configuredMount === mountName) return true;
  const args = Array.isArray(options.shellArgs) ? options.shellArgs : [];
  return typeof options.shellPath === 'string'
    && path.basename(options.shellPath) === 'ssh-bridge'
    && args[0] === hostName;
}

function isManagedRemoteTerminal(terminal: vscode.Terminal): boolean {
  const options = terminal.creationOptions;
  return 'env' in options && typeof options.env?.[terminalIdentityEnv] === 'string';
}

async function suggestReopeningClosedTerminal(terminal: vscode.Terminal): Promise<void> {
  if (!isManagedRemoteTerminal(terminal)
    || terminal.exitStatus?.reason !== vscode.TerminalExitReason.Process) {
    return;
  }
  const selected = await vscode.window.showWarningMessage(
    `远程终端“${terminal.name}”已退出。请运行“Serverless Remote SSH: Open Remote Terminal”重新打开。`,
    openRemoteTerminalAction
  );
  if (selected === openRemoteTerminalAction) {
    await vscode.commands.executeCommand(`${commandPrefix}.openTerminal`);
  }
}

async function resumePendingOpen(context: vscode.ExtensionContext): Promise<void> {
  const pending = context.globalState.get<PendingOpen>(pendingOpenKey);
  if (!pending) return;
  if (!pending.createdAt || Date.now() - pending.createdAt > pendingOpenTtlMs) {
    await context.globalState.update(pendingOpenKey, undefined);
    return;
  }
  const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (current && sameLocalPath(current, pending.localPath)) {
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
    await openTerminal(context, mount, pending.localPath, config);
    return;
  }
  // No current workspace matches the pending open — the local directory may
  // have disappeared (e.g. WSL was shut down). Re-mount and re-open it so
  // the user does not see "Cannot open a non-existent workspace folder".
  if (!current || workspaceCount() === 0) {
    await context.globalState.update(pendingOpenKey, undefined);
    const config = await readConfig();
    const mount = config.mounts.find((item) => item.name === pending.mountName);
    if (!mount) return;
    await withMountLock(pending.localPath, async () => {
      await ensureMountedUnlocked(context, mount, pending.localPath, { config });
    });
    await context.globalState.update(pendingOpenKey, {
      mountName: pending.mountName, localPath: pending.localPath, createdAt: Date.now(), ownsMount: true
    });
    workspaceSwitchMountPath = path.resolve(pending.localPath);
    try {
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(path.resolve(pending.localPath)),
        false
      );
    } finally {
      workspaceSwitchMountPath = undefined;
    }
    return;
  }
}

async function openTerminal(
  context: vscode.ExtensionContext, mountConfig?: MountConfig, cwd?: string,
  loadedConfig?: BridgeConfig, forceNew = false
): Promise<{ terminal: vscode.Terminal; created: boolean } | undefined> {
  let mount = mountConfig;
  let config = loadedConfig;
  if (!mount) {
    config ??= await readConfig();
    const currentPath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
      ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const match = currentPath
      ? findMountForPath(config.mounts, currentPath, platformAdapter.kind, expandHome)
      : undefined;
    mount = match?.mount;
    cwd = match?.cwd;
  }
  let selected;
  if (!mount) {
    selected = await selectMount('Select a remote terminal');
    if (!selected) {
      return undefined;
    }
    mount = selected.mount;
    config = selected.config;
  }
  config ??= await readConfig();
  const resolved = resolveMount(config, mount);
  const configuredLocalPath = mount.local_paths?.[platformAdapter.kind] ?? mount.local_path;
  const localRoot = configuredLocalPath ? expandHome(configuredLocalPath) : undefined;
  const localCwd = cwd ?? localRoot;
  const remoteCwd = localRoot && localCwd
    ? remotePathForLocalPath(mount.remote_path, localRoot, localCwd, platformAdapter.kind)
    : undefined;
  const remoteRoot = path.posix.normalize(mount.remote_path);
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
    const plan = platformAdapter.terminal(
      resolved.hostConfig, remoteCwd, connectionOptions()
    );
    const bridgeEnv = await bridgeMasterPasswordEnv(context, resolved.hostConfig);
    const terminalStartedAt = performance.now();
    const terminal = vscode.window.createTerminal({
      name: terminalName,
      shellPath: plan.command,
      shellArgs: plan.args,
      env: {
        SSH_BRIDGE_MOUNT_NAME: mount.name,
        [terminalIdentityEnv]: terminalId,
        ...plan.env,
        ...bridgeEnv,
        ...credentials?.env
      },
      // The local mount path is only used to calculate remoteCwd above. During
      // an open-folder window reload VS Code briefly has an empty workspace and
      // rejects terminal cwd values outside the user home. SSH changes to the
      // mapped directory remotely, so starting the local client at home is both
      // sufficient and safe in that transient state.
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
      }, pendingOpenTtlMs);
    }
    terminal.show();
    return { terminal, created: true };
  } finally {
    openingTerminalIds.delete(terminalId);
  }
}

async function mountAndOpenTerminal(
  context: vscode.ExtensionContext, config: BridgeConfig,
  match: { mount: MountConfig; localPath: string; cwd: string }
): Promise<void> {
  const host = resolveMount(config, match.mount).hostConfig;
  const canConnectConcurrently = !connectionOptions().reuseSshConnection
    && (!host.password || isEncryptedPassword(host.password));
  if (!canConnectConcurrently) {
    await ensureMountedUnlocked(context, match.mount, match.localPath, {
      config, knownUnmounted: true
    });
    await openTerminal(context, match.mount, match.cwd, config);
    return;
  }
  const [mountResult, terminalResult] = await Promise.allSettled([
    ensureMountedUnlocked(context, match.mount, match.localPath, {
      config, knownUnmounted: true
    }),
    openTerminal(context, match.mount, match.cwd, config)
  ]);
  if (mountResult.status === 'rejected') {
    if (terminalResult.status === 'fulfilled' && terminalResult.value?.created) {
      terminalResult.value.terminal.dispose();
    }
    throw mountResult.reason;
  }
  if (terminalResult.status === 'rejected') throw terminalResult.reason;
}

async function autoOpenWorkspaceTerminal(context: vscode.ExtensionContext): Promise<void> {
  const workspacePaths = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  if (workspacePaths.length === 0) return;
  let config: BridgeConfig;
  try {
    config = await timedPhase('自动连接配置读取', () => loadConfig(configPath()));
  } catch {
    return;
  }
  const activePath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
    ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)
    : undefined;
  const candidates = activePath ? [activePath, ...workspacePaths] : workspacePaths;
  const match = findMountForPaths(config.mounts, candidates, platformAdapter.kind, expandHome);
  if (!match) return;
  return withMountLock(match.localPath, async () => {
  const openedWorkspacePath = workspacePaths.find((workspacePath) =>
    findMountForPath(
      [match.mount], workspacePath, platformAdapter.kind, expandHome
    )?.localPath === match.localPath
  );
  if (openedWorkspacePath) {
    const resolved = resolveMount(config, match.mount);
    const mounted = await timedPhase(
      `${match.mount.name} 启动挂载状态检查`,
      () => commandSucceeds(platformAdapter.status(resolved, match.localPath))
    );
    // An unmounted Windows drive has no directory entry to read, so its
    // missing drive root is the platform equivalent of an empty mount point.
    const empty = !mounted && (
      await isEmptyDirectory(match.localPath, platformAdapter.kind === 'windows')
      || await isEmptyDirectoryTree(match.localPath)
    );
    if (empty) {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `检测到“${match.mount.name}”挂载已断开，正在重新挂载…`,
        cancellable: false
      }, () => mountAndOpenTerminal(context, config, match));
      return;
    }
  }
  await openTerminal(context, match.mount, match.cwd, config);
  });
}

function workspaceCount(): number {
  return vscode.workspace.workspaceFolders?.length ?? 0;
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
  return withMountLock(localPath, async () => {
  let disposedTaskTerminal = false;
  for (const terminal of vscode.window.terminals) {
    if (terminal.name.includes('sshfs-bridge mount ')) {
      terminal.dispose();
      disposedTaskTerminal = true;
    }
  }
  if (disposedTaskTerminal) await new Promise((resolve) => setTimeout(resolve, 300));
  const config = await readConfig();
  await executePlatformUnmount(resolveMount(config, mount), localPath);
  nativeSessionMounts.delete(path.resolve(localPath));
  });
}

async function executePlatformUnmount(remote: ResolvedMount, localPath: string): Promise<void> {
  try {
    await executePlan(platformAdapter.unmount(remote, localPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const busy = platformAdapter.kind === 'macos'
      ? message.includes('Resource busy')
      : message.includes('Device or resource busy');
    if ((platformAdapter.kind !== 'linux' && platformAdapter.kind !== 'macos')
      || !busy || !platformAdapter.lazyUnmount) {
      throw error;
    }
    await executePlan(platformAdapter.lazyUnmount(remote, localPath));
  }
}

async function closeRemote(
  context: vscode.ExtensionContext, requestedMount?: MountConfig
): Promise<void> {
  const selected = requestedMount
    ? { mount: requestedMount, config: await readConfig() }
    : await selectMount('Select a remote folder to close');
  if (selected) {
    const { mount } = selected;
    const expandedPath = await mountDirectory(mount);
    if (!expandedPath) return;
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
  const lines = await Promise.all(config.mounts.map(async (mount) => {
    const expandedPath = await mountDirectory(mount);
    if (!expandedPath) return undefined;
    const mounted = await commandSucceeds(platformAdapter.status(resolveMount(config, mount), expandedPath));
    return `  ${mount.name}: ${mounted ? 'mounted' : 'not mounted'} (${expandedPath})`;
  }));
  for (const line of lines) if (line !== undefined) output.appendLine(line);
  if (platformAdapter.kind === 'wsl') {
    output.appendLine('');
    output.appendLine('Relay');
    for (const line of await relayStatusLines()) output.appendLine(line);
  }
  output.show(true);
}

class RemoteFoldersProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;

  dispose(): void {
    this.changed.dispose();
  }

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    let config: BridgeConfig;
    try {
      config = await readConfig();
    } catch (error) {
      await vscode.commands.executeCommand('setContext', 'serverlessRemote.hasNoMounts', false);
      const message = error instanceof Error ? error.message : String(error);
      const item = new vscode.TreeItem('Cannot read configuration');
      item.description = 'Open config to fix';
      item.iconPath = new vscode.ThemeIcon(
        'warning', new vscode.ThemeColor('list.warningForeground')
      );
      item.tooltip = message;
      item.command = {
        command: `${commandPrefix}.openConfig`,
        title: 'Open Config'
      };
      return [item];
    }

    await vscode.commands.executeCommand(
      'setContext', 'serverlessRemote.hasNoMounts', config.mounts.length === 0
    );
    return Promise.all(config.mounts.map(async (mount) => {
      const localPath = await mountDirectory(mount);
      const resolved = resolveMount(config, mount);
      const mounted = localPath
        ? await commandSucceeds(platformAdapter.status(resolved, localPath))
        : false;
      const item = new vscode.TreeItem(
        mount.name, vscode.TreeItemCollapsibleState.None
      ) as vscode.TreeItem & RemoteMountTreeItem;
      item.mountName = mount.name;
      item.description = `${resolved.hostConfig.user}@${resolved.hostConfig.ip} · ${
        mounted ? 'mounted' : 'not mounted'
      }`;
      item.contextValue = mounted
        ? 'serverlessRemote.mount.mounted'
        : 'serverlessRemote.mount';
      item.iconPath = mounted
        ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'))
        : new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('descriptionForeground'));
      item.tooltip = new vscode.MarkdownString([
        `**${mount.name}**`,
        '',
        `${resolved.hostConfig.user}@${resolved.hostConfig.ip}:${resolved.hostConfig.port ?? 22}`,
        '',
        `Remote: \`${mount.remote_path}\``,
        '',
        `Local: \`${localPath ?? 'Not configured'}\``,
        '',
        mounted ? 'Mounted' : 'Not mounted'
      ].join('\n'));
      item.command = {
        command: `${commandPrefix}.openFolderItem`,
        title: '打开远程文件夹',
        arguments: [item]
      };
      return item;
    }));
  }
}

async function configuredMount(item: RemoteMountTreeItem): Promise<MountConfig> {
  const config = await readConfig();
  const mount = config.mounts.find((candidate) => candidate.name === item.mountName);
  if (!mount) throw new Error(`Remote folder no longer exists: ${item.mountName}`);
  return mount;
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
  // The close-folder operation reloads the extension host. The user may edit
  // or replace the configuration before that reload finishes; in that case
  // this is merely stale cleanup state, not a failure of the next connection.
  if (!mount) return;
  await executeUnmount(mount, pending.localPath);
}

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

  const config = await editableConfig();
  const normalizedName = name.trim();
  const existingIndex = config.hosts.findIndex((host) => host.name === normalizedName);
  if (!await confirmReplacement('SSH', normalizedName, existingIndex >= 0)) return;
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

  const existingMountIndex = config.mounts.findIndex((item) => item.name === normalizedName);
  // A configured local path is authoritative. Only mounts without one receive a
  // workspace-based default.
  const existingMount = existingMountIndex >= 0 ? config.mounts[existingMountIndex] : undefined;
  const existingPath = existingMount?.local_paths?.[platformAdapter.kind] ?? existingMount?.local_path;
  const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const localPath = existingPath
    ? expandHome(existingPath)
    : defaultMountDirectory(
        { name: normalizedName, host: normalizedName, remote_path: '.' },
        current,
        platformAdapter.kind
      );
  const mount: MountConfig = {
    name: normalizedName,
    host: normalizedName,
    remote_path: '.',
    local_path: localPath,
    remote_terminal: 'open'
  };
  if (platformAdapter.kind === 'windows') mount.local_path = 'R:';
  if (existingMountIndex >= 0) config.mounts[existingMountIndex] = mount;
  else config.mounts.push(mount);
  config.encrypt_passwords = true;
  await saveConfig(configPath(), config);
  if (platformAdapter.kind !== 'windows') await mkdir(localPath, { recursive: true });
  void vscode.window.showInformationMessage(
    `已保存“${normalizedName}”；SSH 登录目录将挂载到 ${localPath}`
  );
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
        await vscode.commands.executeCommand(`${commandPrefix}.openConfig`, error.hostName);
      } else if (selected === addSshConfigAction) {
        await vscode.commands.executeCommand(`${commandPrefix}.addSshConfig`);
      }
      return;
    }
    await vscode.window.showErrorMessage(`Serverless Remote SSH: ${message}`);
  }
}

async function missingDependencies(): Promise<string[]> {
  const commands = platformAdapter.dependencies().filter(
    (command) => platformAdapter.kind !== 'windows' || command !== 'sshfs-win.exe'
  );
  const results = await Promise.all(commands.map(async (command) => ({
    command, exists: await commandExists(command)
  })));
  const missing = results.filter(({ exists }) => !exists).map(({ command }) => command);
  if (platformAdapter.kind !== 'windows') return missing;
  const [hasWinFspCommand, hasWinFspDirectory, hasSshfsWinCommand, hasSshfsWinDirectory] =
    await Promise.all([
      commandExists('fsptool-x64.exe'),
      hasWindowsInstallDirectory('WinFsp'),
      commandExists('sshfs-win.exe'),
      hasWindowsInstallDirectory('SSHFS-Win')
    ]);
  if (!hasWinFspCommand && !hasWinFspDirectory) missing.push('WinFsp');
  const hasSshfsWin = hasSshfsWinCommand || hasSshfsWinDirectory;
  if (!hasSshfsWin) missing.push('SSHFS-Win');
  return missing;
}

interface DependencyCache {
  missing: string[];
}

async function showDependencyTips(
  context: vscode.ExtensionContext, force = true
): Promise<void> {
  const platformCacheKey = `${dependencyCacheKey}.${platformAdapter.kind}`;
  const cached = context.globalState.get<DependencyCache>(platformCacheKey);
  const validCache = !force && cached?.missing.length === 0;
  const missing = validCache && cached
    ? cached.missing
    : await timedPhase('依赖检查', missingDependencies);
  if (!validCache) {
    await context.globalState.update(
      platformCacheKey, { missing } satisfies DependencyCache
    );
  }
  if (missing.length === 0) {
    if (force) void vscode.window.showInformationMessage('当前平台所需依赖均已安装。');
    return;
  }
  const guide = await createDependencyGuide(platformAdapter.kind, missing);
  if (!guide) return;
  const copyAction = guide.command ? '复制安装命令' : undefined;
  const linkActions = guide.links ?? (guide.url ? [{ label: '查看安装说明', url: guide.url }] : []);
  const actions = [copyAction, ...linkActions.map((link) => link.label)]
    .filter((item): item is string => item !== undefined);
  const selected = await vscode.window.showWarningMessage(guide.message, ...actions);
  if (selected === copyAction && guide.command) {
    await vscode.env.clipboard.writeText(guide.command);
    void vscode.window.showInformationMessage('安装命令已复制到剪贴板，请在终端中运行。');
  } else {
    const link = linkActions.find((item) => item.label === selected);
    if (link) await vscode.env.openExternal(vscode.Uri.parse(link.url));
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const statusOutput = vscode.window.createOutputChannel('Serverless Remote SSH Status');
  bridgeOutput = vscode.window.createOutputChannel('Serverless Remote SSH');
  context.subscriptions.push(statusOutput, bridgeOutput);
  const remoteFolders = new RemoteFoldersProvider();
  const registrations: Array<[string, () => Promise<void>]> = [
    ['openFolder', () => guard(() => openRemoteFolder(context))],
    ['openTerminal', () =>
      guard(() => openTerminal(context, undefined, undefined, undefined, true))],
    ['close', () => guard(async () => {
      await closeRemote(context);
      remoteFolders.refresh();
    })],
    ['status', () => guard(() => showStatus(statusOutput))],
    ['openConfig', () => guard(() => openConfig())],
    ['addSshConfig', () => guard(async () => {
      await addSshConfig(context);
      remoteFolders.refresh();
    })],
    ['installDependenciesTips', () => guard(() => showDependencyTips(context))]
  ];
  for (const [name, handler] of registrations) {
    context.subscriptions.push(vscode.commands.registerCommand(`${commandPrefix}.${name}`, handler));
  }
  context.subscriptions.push(
    remoteFolders,
    vscode.window.registerTreeDataProvider(`${commandPrefix}.mounts`, remoteFolders),
    vscode.commands.registerCommand(`${commandPrefix}.refreshExplorer`, () => {
      remoteFolders.refresh();
    }),
    vscode.commands.registerCommand(
      `${commandPrefix}.openFolderItem`,
      (item: RemoteMountTreeItem) => guard(async () => {
        await openRemoteFolder(context, await configuredMount(item));
        remoteFolders.refresh();
      })
    ),
    vscode.commands.registerCommand(
      `${commandPrefix}.openTerminalItem`,
      (item: RemoteMountTreeItem) => guard(async () => {
        await openTerminal(
          context, await configuredMount(item), undefined, undefined, true
        );
        remoteFolders.refresh();
      })
    ),
    vscode.commands.registerCommand(
      `${commandPrefix}.closeItem`,
      (item: RemoteMountTreeItem) => guard(async () => {
        await closeRemote(context, await configuredMount(item));
        remoteFolders.refresh();
      })
    )
  );
  context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
    void suggestReopeningClosedTerminal(terminal);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void guard(() => timedPhase(
      '工作区变化自动连接总计',
      () => autoOpenWorkspaceTerminal(context)
    ));
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
  await guard(() => timedPhase(
    '启动自动连接总计',
    () => autoOpenWorkspaceTerminal(context)
  ));
  void guard(() => showDependencyTips(context, false));
}

export async function deactivate(): Promise<void> {
  if (platformAdapter.kind !== 'macos' && platformAdapter.kind !== 'linux') return;
  const mounts = [...nativeSessionMounts.entries()]
    .filter(([mountPath]) => mountPath !== workspaceSwitchMountPath)
    .map(([mountPath, mount]) => ({
      ...mount,
      workspacePaths: vscode.workspace.workspaceFolders
        ?.map((folder) => folder.uri.fsPath)
        .filter((workspacePath) => {
          const relative = path.relative(mountPath, path.resolve(workspacePath));
          return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
        }) ?? []
    }));
  nativeSessionMounts.clear();
  await Promise.allSettled(mounts.map(async ({ remote, localPath, workspacePaths }) => {
    const statusPlan = platformAdapter.status(remote, localPath);
    if (!await commandSucceeds(statusPlan)) return;
    await executePlatformUnmount(remote, localPath);
    await Promise.all(workspacePaths.map((workspacePath) => mkdir(workspacePath, { recursive: true })));
  }));
}
