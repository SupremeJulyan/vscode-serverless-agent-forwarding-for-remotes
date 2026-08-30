import assert from 'node:assert/strict';
import test from 'node:test';
import { keyboardInteractivePasswordReplies } from '../src/authentication';
import {
  RemoteCwdOscTracker, ssh2InteractiveLoginCommand, ssh2RemoteCommand
} from '../src/ssh-command';

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

test('injects transient Bash cwd reporting without editing startup files', () => {
  const command = ssh2InteractiveLoginCommand(`/srv/O'Brien`);
  assert.match(command, /^cd -- '\/srv\/O'/u);
  assert.match(command, /SHELL##\*\//u);
  assert.match(command, /PROMPT_COMMAND/u);
  assert.match(command, /633;P;Cwd/u);
  assert.match(command, /exec "\$\{SHELL:-\/bin\/sh\}" -l$/u);
  assert.doesNotMatch(command, /\.bashrc|\.profile/u);
});

test('tracks split OSC cwd reports and rejects invalid paths', () => {
  const tracker = new RemoteCwdOscTracker();
  assert.deepEqual(tracker.push('prompt\u001b]633;P;C'), []);
  assert.deepEqual(tracker.push('wd=/srv/project/batch_1\u0007$ '), [
    '/srv/project/batch_1'
  ]);
  assert.deepEqual(
    tracker.push('\u001b]633;P;Cwd=relative/path\u0007'),
    []
  );
  assert.deepEqual(
    tracker.push('\u001b]633;P;Cwd=/srv/next\u001b\\'),
    ['/srv/next']
  );
});
