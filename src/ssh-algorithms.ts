/**
 * Legacy SSH algorithm support for servers that only offer `ssh-rsa` / `ssh-dss`.
 *
 * OpenSSH 8.8+ disables SHA-1 based `ssh-rsa` host keys and `ssh-dss` by
 * default, so connecting to such servers fails with:
 *
 *   Unable to negotiate with <host> port 22: no matching host key type found.
 *   Their offer: ssh-rsa,ssh-dss
 *
 * These constants re-enable the legacy algorithms on every connection path
 * (system `ssh` CLI, bundled WSL bridge and the ssh2 library) while keeping
 * all modern algorithms first in the preference order.
 */

import type { ServerHostKeyAlgorithm } from 'ssh2';

/** ssh2 `algorithms.serverHostKey` value (modern keys first, legacy last). */
export const serverHostKeyAlgorithms: ServerHostKeyAlgorithm[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
  'ssh-dss'
];

/**
 * OpenSSH `-o` arguments re-enabling legacy host key and user key algorithms.
 * The `+` prefix appends to the client defaults, so modern keys are kept.
 * Only needed on OpenSSH 8.8+; older clients accept these algorithms anyway.
 */
export const legacySshAlgorithmArgs = [
  '-o', 'HostKeyAlgorithms=+ssh-rsa,ssh-dss',
  '-o', 'PubkeyAcceptedAlgorithms=+ssh-rsa,ssh-dss'
];

/**
 * SSH client identification string sent after `SSH-2.0-`. The ssh2 default
 * (`ssh2js1.x`) is unusual, and some NSG/gateway appliances whitelist known
 * SSH clients (OpenSSH, PuTTY/MobaXterm, SecureCRT…) while rejecting
 * unknown ones at the channel level (e.g. "Unable to start subsystem: sftp",
 * "Unable to request a pseudo-terminal"). Default to an OpenSSH banner;
 * override via the `safs.sshClientIdent` setting.
 */
export const defaultSshClientIdent = 'OpenSSH_9.6';
