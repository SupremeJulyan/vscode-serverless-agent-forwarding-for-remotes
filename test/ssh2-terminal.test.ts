import assert from 'node:assert/strict';
import test from 'node:test';
import { keyboardInteractivePasswordReplies } from '../src/authentication';
import {
  decodeShellIntegrationValue, normalizeRemoteShellPath, RemoteCwdOscTracker,
  remoteIntegratedLoginCommand, remoteShellKind, remoteShellProbeCommand,
  RemoteShellIntegrationScripts
} from '../src/remote-shell-integration';
import { ssh2RemoteCommand } from '../src/ssh-command';

const scripts: RemoteShellIntegrationScripts = {
  bash: '# bash integration\n',
  fish: '# fish integration\n',
  zshEnv: '# zsh env\n',
  zshProfile: '# zsh profile\n',
  zshRc: '# zsh rc\n'
};
const sessionId = '0123456789abcdef01234567';

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

test('builds a file-descriptor-only Bash integration login', () => {
  const command = remoteIntegratedLoginCommand(
    '/bin/bash', `/srv/O'Brien`, scripts, sessionId
  );
  assert.match(command, /^cd -- '\/srv\/O'/u);
  assert.match(command, /--init-file \/dev\/fd\/3 -i/u);
  assert.match(command, /SAFS_BASH_0123456789abcdef01234567/u);
  assert.match(command, /# bash integration/u);
  assert.doesNotMatch(command, /mktemp|cat >/u);
});

test('builds Fish fd injection and private self-cleaning Zsh startup files', () => {
  const fish = remoteIntegratedLoginCommand('/usr/bin/fish', '/srv', scripts, sessionId);
  assert.match(fish, /--init-command 'source \/dev\/fd\/3'/u);
  assert.match(fish, /--help.*grep -q -- '--init-command'/u);
  assert.doesNotMatch(fish, /mktemp/u);

  const zsh = remoteIntegratedLoginCommand('/bin/zsh', '/srv', scripts, sessionId);
  assert.match(zsh, /mktemp -d/u);
  assert.match(zsh, /chmod 700/u);
  assert.match(zsh, /umask 077/u);
  assert.match(zsh, /\.zshenv/u);
  assert.match(zsh, /\.zprofile/u);
  assert.match(zsh, /\.zshrc/u);
  assert.match(zsh, /SAFS_INTEGRATION_DIR/u);
});

test('detects supported remote login shells and rejects unsafe probe output', () => {
  assert.equal(remoteShellProbeCommand(), `printf '%s' "\${SHELL:-/bin/sh}"`);
  assert.equal(normalizeRemoteShellPath(' /bin/bash\n'), '/bin/bash');
  assert.equal(normalizeRemoteShellPath('relative/bash'), undefined);
  assert.equal(normalizeRemoteShellPath('/bin/bash\n/bin/zsh'), undefined);
  assert.equal(remoteShellKind('/bin/bash'), 'bash');
  assert.equal(remoteShellKind('/usr/bin/zsh'), 'zsh');
  assert.equal(remoteShellKind('/usr/local/bin/fish'), 'fish');
  assert.equal(remoteShellKind('/bin/rbash'), 'unsupported');
});

test('falls back for unsupported shells and rejects unsafe session ids', () => {
  assert.equal(
    remoteIntegratedLoginCommand('/bin/ksh', '/srv', scripts, sessionId),
    `cd -- '/srv' && exec '/bin/ksh' -l`
  );
  assert.throws(
    () => remoteIntegratedLoginCommand('/bin/bash', '/srv', scripts, 'bad;id'),
    /Invalid remote shell integration session id/u
  );
});

test('tracks split and escaped OSC cwd reports and rejects invalid paths', () => {
  const tracker = new RemoteCwdOscTracker();
  assert.deepEqual(tracker.push('prompt\u001b]633;P;C'), []);
  assert.deepEqual(tracker.push('wd=/srv/project/batch\\x3b1\u0007$ '), [
    '/srv/project/batch;1'
  ]);
  assert.deepEqual(
    tracker.push('\u001b]633;P;Cwd=relative/path\u0007'),
    []
  );
  assert.deepEqual(
    tracker.push('\u001b]633;P;Cwd=/srv/next\u001b\\'),
    ['/srv/next']
  );
  assert.deepEqual(
    tracker.push('\u001b]633;P;Cwd=/srv/unsafe\\x07path\u0007'),
    []
  );
  assert.deepEqual(
    tracker.push(`\u001b]633;P;Cwd=/${'a'.repeat(5000)}`),
    []
  );
  assert.deepEqual(
    tracker.push('\u001b]633;P;Cwd=/srv/recovered\u0007'),
    ['/srv/recovered']
  );
  assert.equal(decodeShellIntegrationValue('/srv/a\\\\b\\x3bc'), '/srv/a\\b;c');
});
