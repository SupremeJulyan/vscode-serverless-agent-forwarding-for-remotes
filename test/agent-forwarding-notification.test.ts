import assert from 'node:assert/strict';
import test from 'node:test';
import { agentForwardingInstallMessage } from '../src/agent-forwarding-notification.js';

test('lists every Agent whose forwarding registration succeeded', () => {
  assert.equal(
    agentForwardingInstallMessage(['Codex', 'Claude Code'], true),
    'Codex、Claude Code 转发安装成功。'
  );
});

test('deduplicates names and reports a partial registration', () => {
  assert.equal(
    agentForwardingInstallMessage(['Codex', 'Codex'], false),
    'Codex 转发安装成功。其他 Agent 未能自动配置，请查看 SAFS 日志。'
  );
});

test('returns no success message when every configured Agent failed', () => {
  assert.equal(agentForwardingInstallMessage([], false), undefined);
});
