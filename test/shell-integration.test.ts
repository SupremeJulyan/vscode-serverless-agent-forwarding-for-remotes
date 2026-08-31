import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Bash cwd hook is silent when inherited without its function and preserves status', {
  skip: process.platform === 'win32' ? 'Bash integration is Unix-only' : false
}, () => {
  const script = `
    source resources/shell-integration/bash.sh >/dev/null
    false
    eval "$PROMPT_COMMAND" >/dev/null
    with_function=$?
    unset -f __safs_report_cwd
    (exit 23)
    eval "$PROMPT_COMMAND" >/dev/null
    without_function=$?
    printf '%s %s' "$with_function" "$without_function"
  `;
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '1 23');
});
