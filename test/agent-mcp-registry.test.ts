import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import {
  AgentDefinition, AgentMcpCliRunner, builtinAgentDefinitions,
  agentSupportsMcp, agentSupportsMcpFor, piAgentMcpHandler,
  piMcpExtensionInstalled, readPiMcpConfig, resolveAgentDefinitions,
  runAgentMcpOperation
} from '../src/agent-mcp-registry.js';
import type { CapturedProcessResult } from '../src/process.js';

const result = (exitCode: number, stdout = '', stderr = ''): CapturedProcessResult =>
  ({ exitCode, stdout, stderr, truncated: false });

test('builtin definitions cover codex, claude and pi', () => {
  const names = builtinAgentDefinitions.map((def) => def.cliName);
  assert.deepEqual(names, ['codex', 'claude', 'pi']);
  const codex = builtinAgentDefinitions.find((def) => def.cliName === 'codex')!;
  const claude = builtinAgentDefinitions.find((def) => def.cliName === 'claude')!;
  const pi = builtinAgentDefinitions.find((def) => def.cliName === 'pi')!;
  // CLI-based agents have no handler.
  assert.equal(codex.mcp.handler, undefined);
  assert.equal(claude.mcp.handler, undefined);
  // pi is file-config based.
  assert.ok(pi.mcp.handler);
  assert.equal(pi.mcp.handler!.supportsMcp, true);
});

test('claude add uses its own arg style, codex uses codex style', () => {
  const codex = builtinAgentDefinitions.find((def) => def.cliName === 'codex')!;
  const claude = builtinAgentDefinitions.find((def) => def.cliName === 'claude')!;
  assert.deepEqual(codex.mcp.add('safs', 'http://x'), ['mcp', 'add', 'safs', '--url', 'http://x']);
  assert.deepEqual(
    claude.mcp.add('safs', 'http://x'),
    ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'safs', 'http://x']
  );
});

test('resolveAgentDefinitions handles legacy ids, dedup and unknown fallback', () => {
  const resolved = resolveAgentDefinitions(['claudeCode', 'claude', 'codex', 'unknown-cli']);
  assert.deepEqual(resolved.map((def) => def.cliName), ['claude', 'codex', 'unknown-cli']);
  const unknown = resolved.find((def) => def.cliName === 'unknown-cli')!;
  // Unknown CLI falls back to codex-style generic definition.
  assert.deepEqual(unknown.mcp.add('safs', 'http://x'), ['mcp', 'add', 'safs', '--url', 'http://x']);
});

test('agentSupportsMcp and agentSupportsMcpFor', () => {
  assert.equal(agentSupportsMcp(result(0, 'ok')), true);
  assert.equal(agentSupportsMcp(result(1, '', 'unknown command: mcp')), false);
  assert.equal(agentSupportsMcp(result(1, '', 'some other error')), true);
  const codex = builtinAgentDefinitions.find((def) => def.cliName === 'codex')!;
  assert.equal(agentSupportsMcpFor(codex, result(1, '', 'no such command')), false);
  const pi = builtinAgentDefinitions.find((def) => def.cliName === 'pi')!;
  assert.equal(agentSupportsMcpFor(pi, result(1, 'anything')), true);
});

test('runAgentMcpOperation prefers handler over CLI', async () => {
  const calls: string[] = [];
  const handlerDef: AgentDefinition = {
    cliName: 'pi',
    displayName: 'Pi',
    mcp: {
      get: () => [],
      add: () => [],
      remove: () => [],
      handler: {
        supportsMcp: true,
        get: async () => { calls.push('get'); return result(0, 'pi-get'); },
        add: async () => { calls.push('add'); return result(0, 'pi-add'); },
        remove: async () => { calls.push('remove'); return result(0); },
        describeAdd: () => 'manual'
      }
    }
  };
  const runner: AgentMcpCliRunner = {
    run: async (command, args) => { calls.push(`cli:${command}:${args.join(' ')}`); return result(0); },
    log: () => {}
  };
  await runAgentMcpOperation(handlerDef, 'get', undefined, runner);
  await runAgentMcpOperation(handlerDef, 'add', 'http://x', runner);
  await runAgentMcpOperation(handlerDef, 'remove', undefined, runner);
  assert.deepEqual(calls, ['get', 'add', 'remove']);
});

test('runAgentMcpOperation falls back to CLI for command-based agents', async () => {
  const codex = builtinAgentDefinitions.find((def) => def.cliName === 'codex')!;
  const calls: string[] = [];
  const runner: AgentMcpCliRunner = {
    run: async (command, args) => { calls.push(`${command} ${args.join(' ')}`); return result(0); },
    log: () => {}
  };
  await runAgentMcpOperation(codex, 'add', 'http://x', runner);
  await runAgentMcpOperation(codex, 'get', undefined, runner);
  await runAgentMcpOperation(codex, 'remove', undefined, runner);
  assert.deepEqual(calls, [
    'codex mcp add safs --url http://x',
    'codex mcp get safs',
    'codex mcp remove safs'
  ]);
});

// ─── pi 配置文件实现（原 pi-mcp-config.test.ts） ───────────────────────────────

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'pi-mcp-config-test-'));
}

test('add writes streamable-http config and get reads it back', async () => {
  const home = await tempHome();
  try {
    const handler = piAgentMcpHandler({ baseDir: home });
    const url = 'http://127.0.0.1:9848/mcp?token=secret';
    const addResult = await handler.add('safs', url);
    assert.equal(addResult.exitCode, 0);

    const config = await readPiMcpConfig(path.join(home, '.pi', 'agent', 'mcp.json'));
    assert.deepEqual(config.mcpServers?.safs, {
      transport: 'streamable-http',
      url,
      lifecycle: 'eager'
    });

    const getResult = await handler.get('safs');
    assert.equal(getResult.exitCode, 0);
    assert.ok(getResult.stdout.includes(url));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('add preserves other servers and settings', async () => {
  const home = await tempHome();
  try {
    const configPath = path.join(home, '.pi', 'agent', 'mcp.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      settings: { toolPrefix: 'mcp' },
      mcpServers: {
        other: { command: 'npx', args: ['-y', 'some-server'], transport: 'stdio' }
      }
    }, null, 2), 'utf8');
    const handler = piAgentMcpHandler({ baseDir: home });
    await handler.add('safs', 'http://127.0.0.1:9848/mcp?token=secret');
    const config = await readPiMcpConfig(configPath);
    assert.equal(config.settings?.toolPrefix, 'mcp');
    assert.ok(config.mcpServers?.other);
    assert.ok(config.mcpServers?.safs);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('remove deletes only the target server', async () => {
  const home = await tempHome();
  try {
    const handler = piAgentMcpHandler({ baseDir: home });
    await handler.add('safs', 'http://127.0.0.1:9848/mcp?token=secret');
    await handler.add('keep', 'http://127.0.0.1:9849/mcp?token=secret');
    const removeResult = await handler.remove('safs');
    assert.equal(removeResult.exitCode, 0);
    const config = await readPiMcpConfig(path.join(home, '.pi', 'agent', 'mcp.json'));
    assert.equal(config.mcpServers?.safs, undefined);
    assert.ok(config.mcpServers?.keep);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('get reports not-configured with exit 0', async () => {
  const home = await tempHome();
  try {
    const handler = piAgentMcpHandler({ baseDir: home });
    const result = await handler.get('safs');
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /not configured/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('describeAdd explains manual config editing', async () => {
  const home = await tempHome();
  try {
    const handler = piAgentMcpHandler({ baseDir: home });
    const text = handler.describeAdd('safs', 'http://x/mcp');
    assert.match(text, /mcp\.json/);
    assert.match(text, /streamable-http/);
    assert.ok(text.includes('http://x/mcp'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('piMcpExtensionInstalled detects packages in agentDir settings', async () => {
  const home = await tempHome();
  try {
    const settingsPath = path.join(home, '.pi', 'agent', 'settings.json');
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ packages: ['npm:pi-mcp-extension'] }), 'utf8');
    assert.equal(await piMcpExtensionInstalled(home), true);

    // Env-agent-dir variant (VS Code bundled agent).
    const envDir = path.join(home, 'bundled-pi-agent');
    await mkdir(envDir, { recursive: true });
    await writeFile(path.join(envDir, 'settings.json'),
      JSON.stringify({ packages: ['npm:pi-mcp-extension'] }), 'utf8');
    assert.equal(await piMcpExtensionInstalled(home, envDir), true);

    // Neither installed.
    await rm(settingsPath);
    await rm(path.join(envDir, 'settings.json'));
    assert.equal(await piMcpExtensionInstalled(home, envDir), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
