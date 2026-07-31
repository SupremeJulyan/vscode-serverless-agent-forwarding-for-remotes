import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  BridgeConfig, ensureConfigFile, expandHome, HostConfig, loadConfig, MountConfig,
  parseSshLogin, removeMountConfig, resolveMount, saveConfig
} from './config';
import { decryptPassword, encryptPassword, isEncryptedPassword } from './password';
import {
  AskpassCredentials, createAskpassCredentials, platformUsesAskpass
} from './askpass';
import { createPlatformAdapter } from './platform';
import { executeCaptured } from './process';
import { AgentMcpServer } from './agent-mcp';
import { connectSftp } from './sftp/client';
import { SftpConnectionPool } from './sftp/connection-pool';
import {
  RemoteFolder, RemoteFolderRegistry, SftpFileSystemProvider
} from './sftp/filesystem-provider';
import {
  isRemotePathInsideRoot, parseRemoteUri, remoteFileSystemScheme, remoteUri
} from './sftp/uri';

const commandPrefix = 'serverlessRemote';
const masterPasswordSecret = 'serverlessRemote.masterPassword';
const agentMcpTokenSecret = 'serverlessRemote.agentMcpToken';
const defaultNativeConfigPath = '~/serverless-remote-ssh/config.json';
const defaultWslConfigPath = '~/.wsl-vpn-ssh/config.json';
const terminalCredentialTtlMs = 5 * 60 * 1000;
const platformAdapter = createPlatformAdapter();
let output: vscode.OutputChannel;
let pool: SftpConnectionPool;
let registry: RemoteFolderRegistry;
let provider: SftpFileSystemProvider;
let mcp: AgentMcpServer | undefined;

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
      throw new Error(`找不到配置文件：${configPath()}。请先运行“添加 SSH 配置”。`);
    }
    throw error;
  }
}

async function promptMasterPassword(
  context: vscode.ExtensionContext, creating = false
): Promise<string> {
  const saved = await context.secrets.get(masterPasswordSecret);
  if (saved) return saved;
  const first = await vscode.window.showInputBox({
    title: creating ? '设置配置主口令' : '解锁 SSH 密码',
    prompt: creating ? '主口令用于加密配置中的 SSH 密码' : '输入配置文件的加密主口令',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value.length >= 8 ? undefined : '主口令至少需要 8 个字符'
  });
  if (!first) throw new Error('未提供主口令');
  if (creating) {
    const repeated = await vscode.window.showInputBox({
      title: '确认配置主口令',
      prompt: '再次输入相同的主口令',
      password: true,
      ignoreFocusOut: true
    });
    if (repeated !== first) throw new Error('两次输入的主口令不一致');
  }
  await context.secrets.store(masterPasswordSecret, first);
  return first;
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
    password: await decryptPassword(host.password, await promptMasterPassword(context))
  };
}

async function selectMount(placeHolder: string): Promise<MountConfig | undefined> {
  const config = await readConfig();
  if (config.mounts.length === 0) throw new Error('尚未配置远程文件夹');
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

async function openTerminal(requested?: MountConfig, requestedRemoteCwd?: string): Promise<void> {
  const config = await readConfig();
  const location = requested ? undefined : currentRemoteLocation();
  const mount = requested
    ?? config.mounts.find((candidate) => candidate.name === location?.mountName)
    ?? await selectMount('选择要打开终端的 SSH 配置');
  if (!mount) return;
  const folder = await ensureFolder(mount);
  const configuredHost = config.hosts.find((candidate) => candidate.name === mount.host);
  if (!configuredHost) throw new Error(`SSH 主机不存在：${mount.host}`);
  const host = await resolvedHost(vscodeContext, mount.host);
  const remoteCwd = requestedRemoteCwd
    ?? (location?.mountName === mount.name ? location.remotePath : folder.remoteRoot);
  let credentials: AskpassCredentials | undefined;
  if (host.password && platformUsesAskpass(platformAdapter.kind)) {
    credentials = await createAskpassCredentials(host.password);
  }
  const bridgeMasterPassword = platformAdapter.kind === 'wsl' && configuredHost.password
    ? await promptMasterPassword(
        vscodeContext, !isEncryptedPassword(configuredHost.password)
      )
    : undefined;
  const plan = platformAdapter.terminal(host, remoteCwd, {
    reuseSshConnection: settings().get<boolean>('reuseSshConnection', true),
    bridgeMasterPassword
  });
  const terminal = vscode.window.createTerminal({
    name: `SSH: ${mount.name}`,
    shellPath: plan.command,
    shellArgs: plan.args,
    cwd: plan.cwd,
    env: { ...plan.env, ...credentials?.env },
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
    }, terminalCredentialTtlMs);
  }
  terminal.show();
}

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
}

async function openConfig(): Promise<void> {
  const file = await ensureConfigFile(configPath());
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(document);
}

async function input(options: vscode.InputBoxOptions): Promise<string | undefined> {
  return vscode.window.showInputBox({ ...options, ignoreFocusOut: true });
}

async function addSshConfig(context: vscode.ExtensionContext): Promise<void> {
  const name = await input({
    title: '添加 SSH/SFTP 配置',
    prompt: '配置名称',
    value: 'dev',
    validateInput: (value) => value.trim() ? undefined : '配置名称不能为空'
  });
  if (name === undefined) return;
  const loginText = await input({
    title: '添加 SSH/SFTP 配置',
    prompt: 'SSH 登录地址',
    value: `${os.userInfo().username}@10.0.0.1`,
    validateInput: (value) => parseSshLogin(value) ? undefined : '请输入 user@主机'
  });
  if (!loginText) return;
  const login = parseSshLogin(loginText);
  if (!login) return;
  const password = await input({
    title: '添加 SSH/SFTP 配置',
    prompt: 'SSH 密码（留空使用私钥）',
    password: true
  });
  if (password === undefined) return;
  let privateKey: string | undefined;
  let encrypted: string | undefined;
  if (password) {
    encrypted = await encryptPassword(password, await promptMasterPassword(context, true));
  } else {
    privateKey = await input({
      title: '添加 SSH/SFTP 配置',
      prompt: 'SSH 私钥路径',
      value: '~/.ssh/id_ed25519',
      validateInput: (value) => value.trim() ? undefined : '私钥路径不能为空'
    });
    if (!privateKey) return;
  }
  let vpn = false;
  if (platformAdapter.kind === 'wsl') {
    const selection = await vscode.window.showQuickPick([
      {
        label: '直接连接',
        description: 'WSL 可直接访问目标服务器',
        value: false
      },
      {
        label: '通过 Windows VPN 中继',
        description: '需要安装 wsl-vpn-ssh-bridge',
        value: true
      }
    ], {
      title: '添加 SSH/SFTP 配置',
      placeHolder: '选择 SFTP 网络路径',
      ignoreFocusOut: true
    });
    if (!selection) return;
    vpn = selection.value;
  }
  await ensureConfigFile(configPath());
  const config = await loadConfig(configPath());
  const normalizedName = name.trim();
  const host: HostConfig = {
    name: normalizedName,
    ip: login.host,
    user: login.user,
    port: 22,
    ...(platformAdapter.kind === 'wsl' ? { vpn } : {}),
    ...(encrypted ? { password: encrypted } : { private_key_path: privateKey!.trim() })
  };
  const hostIndex = config.hosts.findIndex((item) => item.name === normalizedName);
  const mountIndex = config.mounts.findIndex((item) => item.name === normalizedName);
  if ((hostIndex >= 0 || mountIndex >= 0)
    && await vscode.window.showWarningMessage(
      `配置“${normalizedName}”已存在，是否覆盖？`, { modal: true }, '覆盖'
    ) !== '覆盖') return;
  if (hostIndex >= 0) config.hosts[hostIndex] = host;
  else config.hosts.push(host);
  const mount: MountConfig = {
    name: normalizedName,
    host: normalizedName,
    remote_path: '.',
    remote_terminal: 'open'
  };
  if (mountIndex >= 0) config.mounts[mountIndex] = mount;
  else config.mounts.push(mount);
  config.encrypt_passwords = true;
  await saveConfig(configPath(), config);
  void vscode.window.showInformationMessage(`已保存 SFTP 配置“${normalizedName}”`);
}

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

async function runRemote(input: {
  mountName: string; command: string; remoteCwd?: string;
}): Promise<unknown> {
  const { mount, folder } = await mountAndFolder(input.mountName);
  const requestedCwd = toolPath(folder, input.remoteCwd);
  const remoteCwd = await (await pool.get(mount.host)).realpath(requestedCwd);
  if (!isRemotePathInsideRoot(folder.remoteRoot, remoteCwd)) {
    throw new Error(`远程工作目录通过符号链接超出工作区：${requestedCwd}`);
  }
  const host = await resolvedHost(vscodeContext, mount.host);
  const plan = platformAdapter.exec(host, remoteCwd, input.command, {
    reuseSshConnection: settings().get<boolean>('reuseSshConnection', true)
  });
  return { mountName: mount.name, remoteCwd, ...await executeCaptured(plan) };
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
  return runRemote({
    mountName: input.mountName,
    remoteCwd: folder.remoteRoot,
    command: `grep -rIn --exclude-dir=.git -- ${shellQuote(input.query)} ${
      shellQuote(searchPath)
    } | head -n 1000`
  });
}

class RemoteFoldersProvider implements vscode.TreeDataProvider<MountConfig> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(mount: MountConfig): vscode.TreeItem {
    const connected = registry.get(mount.name) !== undefined;
    const item = new vscode.TreeItem(mount.name);
    item.description = connected ? '已连接 SFTP' : '未连接';
    item.contextValue = connected
      ? 'serverlessRemote.connection.connected'
      : 'serverlessRemote.connection';
    item.iconPath = new vscode.ThemeIcon(connected ? 'vm-active' : 'remote');
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
      await openTerminal(mount, location.remotePath);
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

async function deleteConfig(mount: MountConfig): Promise<void> {
  if (registry.get(mount.name)) throw new Error('请先断开该 SFTP 连接');
  if (await vscode.window.showWarningMessage(
    `确定删除“${mount.name}”配置吗？`, { modal: true }, '删除'
  ) !== '删除') return;
  const config = await readConfig();
  removeMountConfig(config, mount.name);
  await saveConfig(configPath(), config);
}

async function guard(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[错误] ${message}`);
    await vscode.window.showErrorMessage(`Serverless Remote SSH: ${message}`);
  }
}

let vscodeContext: vscode.ExtensionContext;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  vscodeContext = context;
  output = vscode.window.createOutputChannel('Serverless Remote SSH');
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
  const tree = new RemoteFoldersProvider();
  context.subscriptions.push(
    output,
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
  command('openTerminal', () => openTerminal());
  command('openTerminalItem', (mount) => openTerminal(mount));
  command('close', () => disconnect());
  command('closeItem', async (mount) => {
    await disconnect(mount);
    tree.refresh();
  });
  command('status', showStatus);
  command('openConfig', openConfig);
  command('addSshConfig', async () => {
    await addSshConfig(context);
    tree.refresh();
  });
  command('refreshExplorer', async () => tree.refresh());
  command('deleteConfigItem', async (mount) => {
    await deleteConfig(mount);
    tree.refresh();
  });

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

  let token = await context.secrets.get(agentMcpTokenSecret);
  if (!token) {
    token = randomBytes(24).toString('hex');
    await context.secrets.store(agentMcpTokenSecret, token);
  }
  mcp = new AgentMcpServer(
    settings().get<number>('agentMcpPort', 9848),
    token,
    {
      listFolders: async () => {
        const config = await readConfig();
        return Promise.all(config.mounts.map(async (mount) => {
          const folder = await ensureFolder(mount);
          return {
            name: mount.name,
            workspaceUri: remoteUri(folder.mountName, folder.remoteRoot),
            remoteRoot: folder.remoteRoot,
            host: mount.host
          };
        }));
      },
      list: remoteList,
      read: remoteRead,
      write: remoteWrite,
      search: remoteSearch,
      run: runRemote,
      log: (message) => output.appendLine(`[Agent MCP] ${message}`)
    }
  );
  context.subscriptions.push({ dispose: () => void mcp?.stop() });
  await guard(() => mcp!.start());
  await guard(restoreRemoteWorkspaces);

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
