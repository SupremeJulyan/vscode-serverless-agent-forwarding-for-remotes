import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { BridgeConfig, ensureConfigFile, expandHome, loadConfig, MountConfig, resolveMount } from './config';
import { commandExists, commandSucceeds } from './process';
import { CommandPlan, createPlatformAdapter } from './platform';

const commandPrefix = 'serverlessRemote';
const platformAdapter = createPlatformAdapter();

interface PendingOpen {
  mountName: string;
  localPath: string;
  createdAt: number;
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

class ConfigActionRequiredError extends Error {}

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('serverlessRemote');
}

function configPath(): string {
  return expandHome(settings().get<string>('configPath', '~/.wsl-vpn-ssh/config.json'));
}

async function readConfig(): Promise<BridgeConfig> {
  try {
    return await loadConfig(configPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigActionRequiredError(`No config file was found at ${configPath()}.`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigActionRequiredError(`Cannot read ${configPath()}: ${message}`);
  }
}

async function selectMount(placeHolder: string): Promise<MountConfig | undefined> {
  const config = await readConfig();
  if (config.mounts.length === 0) {
    throw new ConfigActionRequiredError('No remote hosts or folders are configured yet.');
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
  const options = plan.cwd || plan.env
    ? { cwd: plan.cwd, env: { ...inheritedEnv, ...plan.env } } : undefined;
  const execution = new vscode.ProcessExecution(plan.command, plan.args, options);
  const task = new vscode.Task(
    { type: 'serverlessRemote', command: plan.command, target: plan.args.at(-1) ?? '' },
    vscode.TaskScope.Global,
    `${plan.command} ${plan.args.join(' ')}`,
    'Serverless Remote SSH',
    execution
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
  await vscode.tasks.executeTask(task);
}

async function executePlan(plan: CommandPlan): Promise<void> {
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

async function ensureMounted(mount: MountConfig, localPath: string): Promise<void> {
  const config = await readConfig();
  const resolved = resolveMount(config, mount);
  const statusPlan = platformAdapter.status(resolved, localPath);
  if (!await commandSucceeds(statusPlan)) {
    await executePlan(platformAdapter.mount(resolved, localPath));
    const timeout = settings().get<number>('mountTimeout', 30);
    if (!await waitForPlan(statusPlan, timeout)) {
      throw new Error(`Timed out waiting for mount: ${localPath}. Check the task terminal for details.`);
    }
  }
}

async function mount(mountConfig?: MountConfig): Promise<string | undefined> {
  const mount = mountConfig ?? await selectMount('Select a remote folder to mount');
  if (!mount) {
    return undefined;
  }
  const localPath = await mountDirectory(mount);
  if (!localPath) {
    return undefined;
  }
  await ensureMounted(mount, localPath);
  void vscode.window.showInformationMessage(`${mount.name} mounted at ${localPath}`);
  return localPath;
}

async function openRemoteFolder(context: vscode.ExtensionContext): Promise<void> {
  const mount = await selectMount('Select a remote folder to open');
  if (!mount) return;
  const localPath = await mountDirectory(mount);
  if (!localPath) return;
  const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (current && current === localPath) {
    await ensureMounted(mount, localPath);
    await openTerminal(mount, localPath);
    return;
  }
  await ensureMounted(mount, localPath);
  await context.globalState.update(pendingOpenKey, {
    mountName: mount.name, localPath, createdAt: Date.now()
  });
  try {
    const opened = await vscode.commands.executeCommand<boolean>(
      'vscode.openFolder', vscode.Uri.file(localPath), false
    );
    if (opened === false) {
      await context.globalState.update(pendingOpenKey, undefined);
    }
  } catch (error) {
    await context.globalState.update(pendingOpenKey, undefined);
    throw error;
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
  if (current !== pending.localPath) return;
  await context.globalState.update(pendingOpenKey, undefined);
  const config = await readConfig();
  const mount = config.mounts.find((item) => item.name === pending.mountName);
  if (!mount) throw new Error(`Pending mount no longer exists: ${pending.mountName}`);
  await openTerminal(mount, pending.localPath);
}

async function openTerminal(mountConfig?: MountConfig, cwd?: string): Promise<void> {
  const mount = mountConfig ?? await selectMount('Select a remote terminal');
  if (!mount) {
    return;
  }
  const config = await readConfig();
  const resolved = resolveMount(config, mount);
  const plan = platformAdapter.terminal(resolved.hostConfig);
  const terminal = vscode.window.createTerminal({
    name: `SSH: ${mount.name}`,
    shellPath: plan.command,
    shellArgs: plan.args,
    env: { SSH_BRIDGE_MOUNT_NAME: mount.name },
    cwd: cwd ?? ((mount.local_paths?.[platformAdapter.kind] ?? mount.local_path)
      ? expandHome(mount.local_paths?.[platformAdapter.kind] ?? mount.local_path!) : undefined),
    isTransient: true
  });
  terminal.show();
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
  const config = await readConfig();
  await executePlan(platformAdapter.unmount(resolveMount(config, mount), localPath));
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
  output.appendLine('');
  output.appendLine('Relay');
  if (platformAdapter.kind === 'wsl') {
    for (const line of await relayStatusLines()) output.appendLine(line);
  } else {
    output.appendLine(`  Not required on ${platformAdapter.kind}; connections use the native network stack.`);
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

async function guard(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ConfigActionRequiredError) {
      const selected = await vscode.window.showErrorMessage(
        `Serverless Remote SSH: ${message}`,
        openConfigAction
      );
      if (selected === openConfigAction) {
        await vscode.commands.executeCommand(`${commandPrefix}.openConfig`);
      }
      return;
    }
    await vscode.window.showErrorMessage(`Serverless Remote SSH: ${message}`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const missing = [];
  for (const command of platformAdapter.dependencies()) {
    if (!await commandExists(command)) {
      missing.push(command);
    }
  }
  if (missing.length) {
    void vscode.window.showWarningMessage(`Serverless Remote SSH requires: ${missing.join(', ')}`);
  }

  const statusOutput = vscode.window.createOutputChannel('Serverless Remote SSH Status');
  context.subscriptions.push(statusOutput);
  const registrations: Array<[string, () => Promise<void>]> = [
    ['openFolder', () => guard(() => openRemoteFolder(context))],
    ['openTerminal', () => guard(() => openTerminal())],
    ['mount', () => guard(() => mount())],
    ['unmount', () => guard(() => unmount(context))],
    ['status', () => guard(() => showStatus(statusOutput))],
    ['openConfig', () => guard(openConfig)]
  ];
  for (const [name, handler] of registrations) {
    context.subscriptions.push(vscode.commands.registerCommand(`${commandPrefix}.${name}`, handler));
  }

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.name = 'Serverless Remote SSH';
  statusBar.text = '$(remote) Serverless SSH';
  statusBar.tooltip = 'Open an SSHFS-backed remote folder';
  statusBar.command = `${commandPrefix}.openFolder`;
  statusBar.show();
  context.subscriptions.push(statusBar);
  await guard(() => resumePendingUnmount(context));
  await guard(() => resumePendingOpen(context));
}

export function deactivate(): void {}
