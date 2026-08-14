import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  resolveAgentPlatform, resolveAgentPlatformSetting, wslBundledCli,
  wslHomeDirectory
} from '../src/agent-platform.js';
import { builtinAgentDefinitions } from '../src/agent-mcp-registry.js';

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
  const platform = await resolveAgentPlatform('wsl', 'windows');
  assert.equal(platform.kind, 'wsl');
  assert.equal(platform.wsl, true);
  assert.equal(typeof platform.home, 'string');
  assert.ok(platform.home.length > 0);
});

test('extension running inside WSL always uses the local WSL home, even with the wsl setting', async () => {
  // Plugin installed inside WSL (VS Code WSL window): os.homedir() is already
  // the WSL home (/home/user), and the Linux filesystem cannot reach the
  // \\wsl.localhost UNC paths wsl.exe would return — no indirection at all.
  const auto = await resolveAgentPlatform('auto', 'wsl');
  assert.equal(auto.kind, 'auto');
  assert.equal(auto.wsl, false);
  assert.equal(auto.home, os.homedir());

  const forced = await resolveAgentPlatform('wsl', 'wsl');
  assert.equal(forced.kind, 'wsl');
  assert.equal(forced.wsl, false);
  assert.equal(forced.home, os.homedir());
});

test('wslHomeDirectory returns undefined without breaking on missing wsl.exe', async () => {
  // Never throws; either the WSL path resolves (real WSL) or it falls back to undefined.
  const home = await wslHomeDirectory();
  assert.ok(home === undefined || (typeof home === 'string' && home.length > 0));
});

test('wslBundledCli finds the Codex CLI inside a WSL VS Code Server extensions layout', async () => {
  const wslHome = await mkdtemp(path.join(os.tmpdir(), 'wsl-home-'));
  try {
    // ~/.vscode-server/extensions/openai.chatgpt-26.810.41047-linux-x64/bin/linux-x86_64/codex
    const extRoot = path.join(
      wslHome, '.vscode-server', 'extensions', 'openai.chatgpt-26.810.41047-linux-x64'
    );
    const binDir = path.join(extRoot, 'bin', 'linux-x86_64');
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, 'codex'), '#!/bin/sh\n', { mode: 0o755 });

    const codex = builtinAgentDefinitions.find((def) => def.cliName === 'codex')!;
    const found = await wslBundledCli(codex, wslHome);
    assert.ok(found, 'expected a bundled CLI candidate to be found');
    // The returned path must resolve to the existing binary (either the WSL
    // Linux path after wslpath, or the Windows-accessible candidate itself).
    assert.ok(found.endsWith('/codex') || found.endsWith('\\codex'));
  } finally {
    await rm(wslHome, { recursive: true, force: true });
  }
});

test('wslBundledCli returns undefined when no matching extension directory exists', async () => {
  const wslHome = await mkdtemp(path.join(os.tmpdir(), 'wsl-home-'));
  try {
    const claude = builtinAgentDefinitions.find((def) => def.cliName === 'claude')!;
    assert.equal(await wslBundledCli(claude, wslHome), undefined);
  } finally {
    await rm(wslHome, { recursive: true, force: true });
  }
});
