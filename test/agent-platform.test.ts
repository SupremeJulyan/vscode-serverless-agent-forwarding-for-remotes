import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import {
  resolveAgentPlatform, resolveAgentPlatformSetting, wslHomeDirectory
} from '../src/agent-platform.js';

test('resolveAgentPlatformSetting maps wsl and falls back to auto', () => {
  assert.equal(resolveAgentPlatformSetting('wsl'), 'wsl');
  assert.equal(resolveAgentPlatformSetting('auto'), 'auto');
  assert.equal(resolveAgentPlatformSetting(undefined), 'auto');
  assert.equal(resolveAgentPlatformSetting(''), 'auto');
  assert.equal(resolveAgentPlatformSetting('linux'), 'auto');
  assert.equal(resolveAgentPlatformSetting(42), 'auto');
});

test('resolveAgentPlatform with auto uses the extension-process home and no WSL indirection', async () => {
  const platform = await resolveAgentPlatform('auto');
  assert.equal(platform.kind, 'auto');
  assert.equal(platform.wsl, false);
  assert.equal(platform.home, os.homedir());
});

test('resolveAgentPlatform with wsl enables WSL indirection with a resolvable home', async () => {
  const platform = await resolveAgentPlatform('wsl');
  assert.equal(platform.kind, 'wsl');
  assert.equal(platform.wsl, true);
  assert.equal(typeof platform.home, 'string');
  assert.ok(platform.home.length > 0);
});

test('wslHomeDirectory returns undefined without breaking on missing wsl.exe', async () => {
  // Never throws; either the WSL path resolves (real WSL) or it falls back to undefined.
  const home = await wslHomeDirectory();
  assert.ok(home === undefined || (typeof home === 'string' && home.length > 0));
});
