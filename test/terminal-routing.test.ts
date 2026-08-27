import assert from 'node:assert/strict';
import test from 'node:test';
import { HostConfig } from '../src/config';
import { shouldUseBuiltinSshTerminal } from '../src/terminal-routing';

const passwordHost: HostConfig = {
  name: 'dev', ip: '10.0.0.2', user: 'alice', password: 'secret'
};

test('direct password terminals use ssh2 on every extension platform', () => {
  for (const kind of ['windows', 'linux', 'macos', 'wsl'] as const) {
    assert.equal(shouldUseBuiltinSshTerminal(kind, passwordHost), true);
  }
});

test('WSL VPN relay, private keys, and explicit fallback keep system SSH', () => {
  assert.equal(shouldUseBuiltinSshTerminal('wsl', { ...passwordHost, vpn: true }), false);
  assert.equal(shouldUseBuiltinSshTerminal('linux', {
    ...passwordHost, private_key_path: '/home/alice/.ssh/id_ed25519'
  }), false);
  assert.equal(shouldUseBuiltinSshTerminal('linux', passwordHost, true), false);
  assert.equal(shouldUseBuiltinSshTerminal('linux', {
    ...passwordHost, password: undefined
  }), false);
});
