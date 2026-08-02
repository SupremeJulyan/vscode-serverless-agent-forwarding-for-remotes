import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { AgentMcpServer } from '../src/agent-mcp';

const routerPath = path.resolve('resources/agent-mcp/mcp-router.cjs');

function callbacks(label: string) {
  return {
    listFolders: async () => [],
    currentWorkspace: async () => ({
      name: 'A', workspaceUri: 'serverless-sftp://a/srv/a', remoteRoot: '/srv/a', host: 'dev'
    }),
    list: async (input: unknown) => ({ label, input }),
    read: async (input: unknown) => ({ label, input }),
    write: async (input: unknown) => ({ label, input }),
    search: async (input: unknown) => ({ label, input }),
    run: async (input: unknown) => ({ label, input })
  };
}

test('stdio router discovers the active window and follows a reconnected mount to its new port', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'serverless-router-'));
  const discovery = path.join(home, '.serverless-remote-ssh', 'agent-workspaces');
  await mkdir(discovery, { recursive: true });

  const child = spawn(process.execPath, [routerPath], {
    env: { ...process.env, HOME: home, USERPROFILE: '' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  let output = '';
  const pending = new Map<number, (value: any) => void>();
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
    while (output.includes('\n')) {
      const index = output.indexOf('\n');
      const line = output.slice(0, index);
      output = output.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  let nextId = 0;
  const request = (method: string, params: unknown) => new Promise<any>((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const writeRecord = async (instanceId: string, mcpUrl: string) => {
    await writeFile(path.join(discovery, `${instanceId}.json`), JSON.stringify({
      version: 1, instanceId, focused: true, execution: 'remote',
      workspaceUri: 'serverless-sftp://a/srv/a', mountName: 'A', remoteRoot: '/srv/a',
      host: 'dev', mcpUrl,
      updatedAt: new Date().toISOString()
    }));
  };

  const first = new AgentMcpServer(0, 'first', callbacks('first'));
  const second = new AgentMcpServer(0, 'second', callbacks('second'));
  try {
    await first.start();
    await writeRecord('old-a', first.url);
    const connected = await request('tools/call', {
      name: 'remote_read', arguments: { path: 'README.md' }
    });
    assert.equal(JSON.parse(connected.result.content[0].text).label, 'first');

    await first.stop();
    await rm(path.join(discovery, 'old-a.json'));
    const disconnected = await request('tools/call', {
      name: 'remote_read', arguments: { path: 'README.md' }
    });
    assert.equal(disconnected.result.isError, true);
    assert.equal(JSON.parse(disconnected.result.content[0].text).code, 'NO_ACTIVE_REMOTE');

    await second.start();
    await writeRecord('new-a', second.url);
    const reconnected = await request('tools/call', {
      name: 'remote_read', arguments: { path: 'README.md' }
    });
    assert.equal(JSON.parse(reconnected.result.content[0].text).label, 'second');
  } finally {
    child.kill();
    await Promise.allSettled([first.stop(), second.stop()]);
    await rm(home, { recursive: true, force: true });
  }
});
