import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import {
  agentGuidanceEnd, agentGuidanceStart, maintainAgentGuidance, upsertAgentGuidance
} from '../src/agent-guidance';

test('adds and updates one managed guidance block without changing user instructions', () => {
  const userContent = '# Project rules\n\n- Run tests.\n';
  const added = upsertAgentGuidance(userContent);
  assert.match(added, /^# Project rules/);
  assert.equal(added.split(agentGuidanceStart).length - 1, 1);
  assert.equal(upsertAgentGuidance(added), added);
});

test('refuses to overwrite an incomplete managed block', () => {
  assert.throws(
    () => upsertAgentGuidance(`${agentGuidanceStart}\nold content`),
    /incomplete Serverless Remote SSH managed block/
  );
});

test('maintains the effective override file when one exists', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverless-remote-guidance-'));
  const overridePath = path.join(directory, 'AGENTS.override.md');
  await writeFile(overridePath, '# Existing override\n', 'utf8');
  const result = await maintainAgentGuidance(directory);
  assert.equal(result.filePath, overridePath);
  assert.equal(result.changed, true);
  const content = await readFile(overridePath, 'utf8');
  assert.match(content, /^# Existing override/);
  assert.match(content, new RegExp(agentGuidanceEnd));
});

test('creates AGENTS.md and reports an unchanged second maintenance pass', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverless-remote-guidance-'));
  const first = await maintainAgentGuidance(directory);
  const second = await maintainAgentGuidance(directory);
  assert.equal(first.filePath, path.join(directory, 'AGENTS.md'));
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
});
