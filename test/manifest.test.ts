import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

interface ExtensionManifest {
  version: string;
  activationEvents?: string[];
}

test('extension declares the SFTP filesystem activation event', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;

  assert.equal(manifest.version, '1.0.0');
  assert.ok(manifest.activationEvents?.includes('onFileSystem:serverless-sftp'));
  assert.equal(manifest.activationEvents?.includes('*'), false);
});
