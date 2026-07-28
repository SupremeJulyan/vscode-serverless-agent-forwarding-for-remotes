import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

interface ExtensionManifest {
  version: string;
  activationEvents?: string[];
}

test('extension activates immediately so first-install dependency tips can run', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;

  assert.equal(manifest.version, '0.9.7');
  assert.ok(manifest.activationEvents?.includes('*'));
});
