import assert from 'node:assert/strict';
import test from 'node:test';
import {
  kexAlgorithmsArgsFor, legacySshAlgorithmArgsFor, parseSshVersion, SshCapabilities
} from '../src/ssh-algorithms';

test('parses OpenSSH version strings from macOS, Linux and Windows', () => {
  assert.deepEqual(parseSshVersion('OpenSSH_8.1p1, LibreSSL 2.7.3'), [8, 1]);
  assert.deepEqual(parseSshVersion('OpenSSH_9.0p1, LibreSSL 3.3.6'), [9, 0]);
  assert.deepEqual(parseSshVersion('OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2'), [9, 5]);
  assert.deepEqual(parseSshVersion('OpenSSH_7.4p1 Debian-10+deb9u7'), [7, 4]);
  assert.equal(parseSshVersion('PuTTY Release 0.78'), undefined);
});

test('clients before OpenSSH 8.5 omit PubkeyAcceptedAlgorithms', () => {
  // macOS Big Sur / Catalina and older Linux distros ship these versions.
  const args = legacySshAlgorithmArgsFor({ sshPath: '/usr/bin/ssh', version: [8, 1] });
  assert.deepEqual(args, ['-o', 'HostKeyAlgorithms=+ssh-rsa,ssh-dss']);
});

test('OpenSSH 8.5+ re-enables legacy user key algorithms', () => {
  const args = legacySshAlgorithmArgsFor({ sshPath: '/usr/bin/ssh', version: [9, 0] });
  assert.deepEqual(args, [
    '-o', 'HostKeyAlgorithms=+ssh-rsa,ssh-dss',
    '-o', 'PubkeyAcceptedAlgorithms=+ssh-rsa,ssh-dss'
  ]);
});

test('OpenSSH 10 (DSA removed) never emits ssh-dss', () => {
  const caps: SshCapabilities = {
    sshPath: '/usr/bin/ssh',
    version: [10, 0],
    sigAlgorithms: new Set([
      'ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-256', 'rsa-sha2-512', 'ssh-rsa'
    ])
  };
  assert.deepEqual(legacySshAlgorithmArgsFor(caps), [
    '-o', 'HostKeyAlgorithms=+ssh-rsa',
    '-o', 'PubkeyAcceptedAlgorithms=+ssh-rsa'
  ]);
});

test('drops ssh-dss when the client capability query does not list it', () => {
  const caps: SshCapabilities = {
    sshPath: '/usr/bin/ssh',
    version: [9, 8],
    sigAlgorithms: new Set(['ssh-ed25519', 'ssh-rsa', 'rsa-sha2-256'])
  };
  assert.deepEqual(legacySshAlgorithmArgsFor(caps), [
    '-o', 'HostKeyAlgorithms=+ssh-rsa',
    '-o', 'PubkeyAcceptedAlgorithms=+ssh-rsa'
  ]);
});

test('unknown client version keeps the previous permissive defaults', () => {
  const args = legacySshAlgorithmArgsFor(undefined);
  assert.deepEqual(args, [
    '-o', 'HostKeyAlgorithms=+ssh-rsa,ssh-dss',
    '-o', 'PubkeyAcceptedAlgorithms=+ssh-rsa,ssh-dss'
  ]);
});

test('builds a capability-filtered KexAlgorithms list to suppress the PQ warning', () => {
  const caps: SshCapabilities = {
    sshPath: '/usr/bin/ssh',
    version: [10, 3],
    sigAlgorithms: new Set(['ssh-ed25519', 'ssh-rsa']),
    kexAlgorithms: new Set([
      'curve25519-sha256', 'ecdh-sha2-nistp256', 'diffie-hellman-group14-sha1',
      'diffie-hellman-group-exchange-sha1', 'sntrup761x25519-sha512'
    ])
  };
  const args = kexAlgorithmsArgsFor(caps);
  assert.equal(args.length, 2);
  assert.equal(args[0], '-o');
  const list = args[1].replace('KexAlgorithms=', '');
  // PQ first, then modern, then legacy; unknown ones filtered out.
  assert.ok(list.startsWith('sntrup761x25519-sha512,curve25519-sha256'));
  assert.ok(list.includes('diffie-hellman-group14-sha1'));
  assert.ok(!list.includes('mlkem768x25519-sha256')); // not supported by client
});

test('no KexAlgorithms option when the client cannot be queried', () => {
  assert.deepEqual(kexAlgorithmsArgsFor(undefined), []);
  assert.deepEqual(kexAlgorithmsArgsFor({ sshPath: '/usr/bin/ssh' }), []);
});
