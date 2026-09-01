import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

test('Bash, Fish and Zsh integrations emit the rich OSC 633 command lifecycle', async () => {
  const root = new URL('../resources/shell-integration/', import.meta.url);
  const [bash, fish, zsh] = await Promise.all([
    readFile(new URL('bash.sh', root), 'utf8'),
    readFile(new URL('fish.fish', root), 'utf8'),
    readFile(new URL('zsh-rc.zsh', root), 'utf8')
  ]);
  for (const script of [bash, zsh]) {
    assert.match(script, /633;A/u);
    assert.match(script, /633;B/u);
    assert.match(script, /633;E;/u);
    assert.match(script, /633;C/u);
    assert.match(script, /633;D;/u);
    assert.match(script, /HasRichCommandDetection=True/u);
    assert.match(script, /633;P;Cwd=/u);
  }
  assert.match(fish, /633;%s/u);
  for (const marker of ['A', 'B', 'C', 'D', 'E', 'P']) {
    assert.match(fish, new RegExp(`__safs_escape_sequence ${marker}(?: |$)`, 'mu'));
  }
  assert.match(fish, /HasRichCommandDetection=True/u);
  assert.match(fish, /Cwd=/u);
  assert.match(bash, /return "\$status"/u);
  assert.match(fish, /fish_preexec/u);
  assert.match(fish, /fish_postexec/u);
  assert.match(zsh, /add-zsh-hook preexec/u);
  assert.match(zsh, /add-zsh-hook precmd/u);
});
