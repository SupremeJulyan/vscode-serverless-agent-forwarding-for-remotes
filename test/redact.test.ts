import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSensitiveText } from '../src/redact';

test('redacts bearer tokens and URL token parameters', () => {
  const text = 'curl -H "Authorization: Bearer sk-abc123" "http://127.0.0.1:9848/mcp?token=secret&api_key=xyz"';
  const redacted = redactSensitiveText(text);
  assert.ok(!redacted.includes('sk-abc123'));
  assert.ok(!redacted.includes('secret'));
  assert.ok(!redacted.includes('xyz'));
  assert.match(redacted, /Bearer <hidden>/);
  assert.match(redacted, /token=<hidden>/);
});

test('redacts secret-key flags and KEY=value assignments', () => {
  const text = 'export API_KEY=supersecret && mycli --token tok-123 --api-key=key456 --password pw789';
  const redacted = redactSensitiveText(text);
  assert.ok(!redacted.includes('supersecret'));
  assert.ok(!redacted.includes('tok-123'));
  assert.ok(!redacted.includes('key456'));
  assert.ok(!redacted.includes('pw789'));
  assert.match(redacted, /API_KEY=<hidden>/);
  assert.match(redacted, /--token <hidden>/);
});

test('redacts quoted assignments, URL credentials, and curl basic auth', () => {
  const text = `export API_KEY='secret one'; TOKEN="secret two"; `
    + 'psql postgres://alice:db-password@db/prod; curl -u alice:web-password https://x';
  const redacted = redactSensitiveText(text);
  for (const secret of ['secret one', 'secret two', 'db-password', 'alice:web-password']) {
    assert.equal(redacted.includes(secret), false);
  }
  assert.match(redacted, /API_KEY='<hidden>'/);
  assert.match(redacted, /postgres:\/\/alice:<hidden>@db/);
  assert.match(redacted, /curl -u <hidden>/);
});

test('leaves ordinary commands and safe URLs intact', () => {
  const text = 'git status && curl "http://127.0.0.1:9848/health" && ls -la /srv/project';
  assert.equal(redactSensitiveText(text), text);
});
