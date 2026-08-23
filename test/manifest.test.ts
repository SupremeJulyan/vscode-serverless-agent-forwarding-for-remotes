import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

interface ExtensionManifest {
  version: string;
  activationEvents?: string[];
  extensionKind?: string[];
  contributes?: {
    commands?: Array<{ command: string; title: string }>;
    menus?: {
      'view/item/context'?: Array<{ command: string; when?: string }>;
      'explorer/context'?: Array<{ command: string; when?: string }>;
    };
    configuration?: { properties?: Record<string, { default?: unknown }> };
    jsonValidation?: Array<{ fileMatch?: string[] }>;
  };
}

test('extension declares the SFTP filesystem activation event', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;

  assert.equal(manifest.version, '1.6.2');
  assert.ok(manifest.activationEvents?.includes('onFileSystem:safs'));
  assert.ok(manifest.activationEvents?.includes('onCommand:safs.switchRemoteDirectory'));
  assert.equal(manifest.activationEvents?.includes('*'), false);
  assert.deepEqual(manifest.extensionKind, ['workspace']);
});

test('contributes a remote-directory switch command instead of relying on the local picker', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const commands = manifest.contributes?.commands ?? [];
  assert.ok(commands.some((item) => item.command === 'safs.switchRemoteDirectory'));
});

test('shows separate Agent forwarding actions for enabled and disabled mounts', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const commands = manifest.contributes?.commands ?? [];
  assert.ok(commands.some((item) => item.command === 'safs.enableAiForwardItem'));
  assert.ok(commands.some((item) => item.command === 'safs.disableAiForwardItem'));
  assert.ok(commands.some(
    (item) => item.command === 'safs.copyStreamableHttpUrl'
  ));
  assert.equal(commands.some((item) => item.command === 'safs.toggleAiForwardItem'), false);
  const menu = manifest.contributes?.menus?.['view/item/context'] ?? [];
  assert.ok(menu.some((item) => item.command === 'safs.enableAiForwardItem'
    && item.when?.includes('aiDisabled')));
  assert.ok(menu.some((item) => item.command === 'safs.disableAiForwardItem'
    && item.when?.includes('aiEnabled')));
});

test('packages Agent integration without a spawned stdio router or Codex plugin', async () => {
  await access(new URL('../src/agent-http-router.ts', import.meta.url));
  const extensionSource = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.equal(extensionSource.includes('mcp-router.cjs'), false);
  assert.equal(extensionSource.includes("'--', 'node'"), false);
  await assert.rejects(access(new URL(
    '../plugins/safs/.codex-plugin/plugin.json', import.meta.url
  )));
});

test('shows when this window is the Agent forwarding focus', async () => {
  const extensionSource = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.ok(extensionSource.includes(
    '$(sparkle) Agent 已聚焦当前窗口😏'
  ));
  assert.ok(extensionSource.includes(
    '$(sparkle) ${source}远程转发中💪'
  ));
  // 悬停说明路由关系；同步镜像窗口注明改动与远程双向同步。
  assert.ok(extensionSource.includes('本窗口的远程连接干活'));
  assert.ok(extensionSource.includes('改动与远程双向同步'));
  assert.ok(extensionSource.includes('isSyncMirrorWindow()'));
  assert.ok(extensionSource.includes("value: 'wsl'"));
  assert.ok(extensionSource.includes("value: 'mac'"));
  assert.ok(extensionSource.includes("value: 'linux'"));
  assert.ok(extensionSource.includes("value: 'win'"));
  assert.ok(extensionSource.includes('updateSafsStatusBar(vscode.window.state.focused)'));
  assert.ok(extensionSource.includes('if (agentName && agentPlatform)'));
  assert.ok(extensionSource.includes(
    'updateSafsStatusBar(vscode.window.state.focused, agentName, agentPlatform)'
  ));
  assert.ok(extensionSource.includes("'safs.agentForwardingFocus'"));
  assert.ok(extensionSource.includes('vscode.StatusBarAlignment.Left, 10_000'));
  // SAFS SFTP 入口与转发焦点提示分项显示（与 SAFS SYNC 一致），互不顶替。
  assert.ok(extensionSource.includes("'safs.sftpEntry'"));
  assert.ok(extensionSource.includes("'$(remote) SAFS SCP'"));
  assert.ok(extensionSource.includes("'$(remote) SAFS SFTP'"));
  assert.ok(extensionSource.includes('forwardingFocusStatusBar.show()'));
  assert.ok(extensionSource.includes('forwardingFocusStatusBar.hide()'));
  // 服务器无 SFTP 子系统回退 SCP/exec 时，入口显示为 SAFS SCP 并即时刷新。
  assert.ok(extensionSource.includes('refreshSafsEntryLabel()'));
  // 连接状态变化事件即时刷新入口文案（重连换通道、空闲回收后懒重连）。
  assert.ok(extensionSource.includes('refreshTree();\n      refreshSafsEntryLabel()'));
});

test('uses only the unified cross-platform config path', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.configPath']?.default,
    '~/.safs/config.json'
  );
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.[
      'safs.agentForwardingAgents'
    ]?.default,
    ['codex', 'claude', 'pi', 'dsh']
  );
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.agentPlatform']?.default,
    'auto'
  );
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.agentHttpRouterPort']
      ?.default,
    9848
  );
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.agentMcpTimeoutMs']
      ?.default,
    120000
  );
  const matches = manifest.contributes?.jsonValidation?.flatMap((item) => item.fileMatch ?? []);
  assert.deepEqual(matches, ['**/.safs/config.json']);
});

test('declares host key change action setting', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const property = manifest.contributes?.configuration?.properties?.[
    'safs.hostKeyChangedAction'
  ] as { type?: string; enum?: string[]; default?: unknown } | undefined;
  assert.equal(property?.type, 'string');
  assert.deepEqual(property?.enum, ['prompt', 'reject', 'accept']);
  assert.equal(property?.default, 'prompt');
});

test('declares the visual download command and the renamed sync command', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const commands = manifest.contributes?.commands ?? [];
  const download = commands.find((item) => item.command === 'safs.visualDownload');
  const sync = commands.find((item) => item.command === 'safs.syncToLocal');
  assert.equal(download?.title, 'SAFS：可视化下载');
  assert.equal(sync?.title, 'SAFS：可视化同步');
  const explorerMenu = manifest.contributes?.menus?.['explorer/context'] ?? [];
  assert.equal(
    explorerMenu.some((item) => item.command === 'safs.visualDownload'),
    true
  );
});

test('declares the visual upload command on local file/folder context menus', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const commands = manifest.contributes?.commands ?? [];
  const upload = commands.find((item) => item.command === 'safs.visualUpload');
  assert.equal(upload?.title, 'SAFS：可视化上传');
  const explorerMenu = manifest.contributes?.menus?.['explorer/context'] ?? [];
  const entry = explorerMenu.find((item) => item.command === 'safs.visualUpload');
  assert.equal(entry?.when, 'resourceScheme == file');
});
