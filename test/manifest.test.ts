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
    };
    configuration?: { properties?: Record<string, { default?: unknown }> };
    jsonValidation?: Array<{ fileMatch?: string[] }>;
  };
}

test('extension declares the SFTP filesystem activation event', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;

  assert.equal(manifest.version, '2.0.3');
  assert.ok(manifest.activationEvents?.includes('onFileSystem:serverless-sftp'));
  assert.equal(manifest.activationEvents?.includes('*'), false);
  assert.deepEqual(manifest.extensionKind, ['workspace']);
});

test('shows separate Agent forwarding actions for enabled and disabled mounts', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const commands = manifest.contributes?.commands ?? [];
  assert.ok(commands.some((item) => item.command === 'serverlessRemote.enableAiForwardItem'));
  assert.ok(commands.some((item) => item.command === 'serverlessRemote.disableAiForwardItem'));
  assert.ok(commands.some(
    (item) => item.command === 'serverlessRemote.copyDesktopAgentMcpUrl'
  ));
  assert.equal(commands.some((item) => item.command === 'serverlessRemote.toggleAiForwardItem'), false);
  const menu = manifest.contributes?.menus?.['view/item/context'] ?? [];
  assert.ok(menu.some((item) => item.command === 'serverlessRemote.enableAiForwardItem'
    && item.when?.includes('aiDisabled')));
  assert.ok(menu.some((item) => item.command === 'serverlessRemote.disableAiForwardItem'
    && item.when?.includes('aiEnabled')));
});

test('packages Agent integration without a spawned stdio router or Codex plugin', async () => {
  await access(new URL('../src/agent-http-router.ts', import.meta.url));
  const extensionSource = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.equal(extensionSource.includes('mcp-router.cjs'), false);
  assert.equal(extensionSource.includes("'--', 'node'"), false);
  await assert.rejects(access(new URL(
    '../plugins/serverless-remote/.codex-plugin/plugin.json', import.meta.url
  )));
});

test('uses only the unified cross-platform config path', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  assert.equal(
    manifest.contributes?.configuration?.properties?.['serverlessRemote.configPath']?.default,
    '~/.serverless-remote-ssh/config.json'
  );
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.[
      'serverlessRemote.agentForwardingAgents'
    ]?.default,
    ['codex', 'claudeCode']
  );
  assert.equal(
    manifest.contributes?.configuration?.properties?.[
      'serverlessRemote.agentHttpRouterPort'
    ]?.default,
    9848
  );
  const matches = manifest.contributes?.jsonValidation?.flatMap((item) => item.fileMatch ?? []);
  assert.deepEqual(matches, ['**/.serverless-remote-ssh/config.json']);
});
