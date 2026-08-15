import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import test from 'node:test';
import type { AgentDefinition } from '../src/agent-mcp-registry';
import {
  bundledCliCandidate, resolveAgentPlatform, resolveAgentPlatformSetting,
  wslBashInvocation, wslHomeDirectory
} from '../src/agent-platform';

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

test('extension running inside WSL treats agentPlatform=wsl as local (equivalent to auto)', async () => {
  // 插件本身装在 WSL 里（VS Code WSL 窗口）：无论设置值如何都直接使用本地
  // 家目录、不做 wsl.exe 间接解析（WSL 内无法访问 wsl.exe 返回的 UNC 路径）。
  const platform = await resolveAgentPlatform('wsl', 'wsl');
  assert.equal(platform.kind, 'wsl');
  assert.equal(platform.wsl, false);
  assert.equal(platform.home, os.homedir());
  const auto = await resolveAgentPlatform('auto', 'wsl');
  assert.deepEqual(
    { home: platform.home, wsl: platform.wsl },
    { home: auto.home, wsl: auto.wsl }
  );
});

test('wslHomeDirectory returns undefined without breaking on missing wsl.exe', async () => {
  // Never throws; either the WSL path resolves (real WSL) or it falls back to undefined.
  const home = await wslHomeDirectory();
  assert.ok(home === undefined || (typeof home === 'string' && home.length > 0));
});

test('wslBashInvocation builds an interactive-config bash command with positional args', () => {
  const invocation = wslBashInvocation('command -v -- "$1" >/dev/null 2>&1', ['codex']);
  assert.equal(invocation.command, 'wsl.exe');
  assert.ok(invocation.args.includes('bash'));
  const script = invocation.args[invocation.args.indexOf('-c') + 1];
  assert.ok(script.includes('export PS1="safs $ "'));
  assert.ok(script.includes('. "$HOME/.bashrc"'));
  assert.ok(script.includes('command -v -- "$1"'));
  assert.equal(invocation.args.at(-1), 'codex');
});

test('bundledCliCandidate picks the first existing candidate on local paths', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-bundled-'));
  await mkdir(path.join(directory, 'bin'), { recursive: true });
  const existing = path.join(directory, 'bin', 'codex');
  await writeFile(existing, '#!/bin/sh\n');
  const def: AgentDefinition = {
    cliName: 'codex',
    displayName: 'Codex',
    extensionId: 'openai.chatgpt',
    bundledCandidates: async (extensionPath) => [
      path.join(extensionPath, 'bin', 'missing'),
      path.join(extensionPath, 'bin', 'codex')
    ],
    mcp: { get: () => [], add: () => [], remove: () => [] }
  };
  assert.equal(await bundledCliCandidate(def, directory, 'linux'), existing);
});
