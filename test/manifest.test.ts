import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

interface ExtensionManifest {
  version: string;
  activationEvents?: string[];
  extensionKind?: string[];
  contributes?: {
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
