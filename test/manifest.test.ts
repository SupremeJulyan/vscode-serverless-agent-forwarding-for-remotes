import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

  assert.equal(manifest.version, '2.0.0');
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
  assert.equal(commands.some((item) => item.command === 'serverlessRemote.toggleAiForwardItem'), false);
  const menu = manifest.contributes?.menus?.['view/item/context'] ?? [];
  assert.ok(menu.some((item) => item.command === 'serverlessRemote.enableAiForwardItem'
    && item.when?.includes('aiDisabled')));
  assert.ok(menu.some((item) => item.command === 'serverlessRemote.disableAiForwardItem'
    && item.when?.includes('aiEnabled')));
});

test('uses the cross-platform config path while retaining legacy schema matches', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  assert.equal(
    manifest.contributes?.configuration?.properties?.['serverlessRemote.configPath']?.default,
    '~/.serverless-remote-ssh/config.json'
  );
  const matches = manifest.contributes?.jsonValidation?.flatMap((item) => item.fileMatch ?? []);
  assert.ok(matches?.includes('**/.serverless-remote-ssh/config.json'));
  assert.ok(matches?.includes('**/serverless-remote-ssh/config.json'));
  assert.ok(matches?.includes('**/.wsl-vpn-ssh/config.json'));
});
