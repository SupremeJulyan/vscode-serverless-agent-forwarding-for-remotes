import assert from 'node:assert/strict';
import test from 'node:test';
import { keyboardInteractivePasswordReplies } from '../src/authentication';
import { ssh2RemoteCommand } from '../src/ssh-command';

test('answers only non-echoing keyboard-interactive password prompts', () => {
  assert.deepEqual(
    keyboardInteractivePasswordReplies([{ prompt: 'Password: ', echo: false }], 'secret'),
    ['secret']
  );
  assert.equal(
    keyboardInteractivePasswordReplies([{ prompt: 'Verification code: ', echo: false }], 'secret'),
    undefined
  );
  assert.equal(
    keyboardInteractivePasswordReplies([{ prompt: 'Password: ', echo: true }], 'secret'),
    undefined
  );
});

test('builds a non-interactive ssh2 command with safely quoted cwd and command', () => {
  assert.equal(
    ssh2RemoteCommand(`/srv/O'Brien`, `printf '%s\\n' "hello world"`),
    `cd -- '/srv/O'"'"'Brien' && exec "\${SHELL:-/bin/sh}" -lc 'printf '"'"'%s\\n'"'"' "hello world"'`
  );
});
