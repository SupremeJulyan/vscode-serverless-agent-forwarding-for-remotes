/**
 * Legacy SSH algorithm support for servers that only offer `ssh-rsa` / `ssh-dss`.
 *
 * OpenSSH 8.8+ disables SHA-1 based `ssh-rsa` host keys and `ssh-dss` by
 * default, so connecting to such servers fails with:
 *
 *   Unable to negotiate with <host> port 22: no matching host key type found.
 *   Their offer: ssh-rsa,ssh-dss
 *
 * The system `ssh` flags re-enable the legacy algorithms while keeping all
 * modern algorithms first in the preference order. They must be adapted to
 * the installed client:
 *
 *  - `PubkeyAcceptedAlgorithms` only exists since OpenSSH 8.5. Older clients
 *    abort the whole command with "Bad configuration option:
 *    PubkeyAcceptedAlgorithms" (exit code 255). macOS Big Sur/Catalina ship
 *    OpenSSH 8.1, and older Linux distros (Ubuntu 20.04's 8.2, CentOS 7's
 *    7.4, …) are affected.
 *  - `ssh-dss` (DSA) was removed entirely in OpenSSH 10.0, where listing it
 *    is now a syntax error ("Bad key types '+ssh-rsa,ssh-dss'"). macOS
 *    Tahoe (26) and other OpenSSH 10+ clients are affected.
 *
 * The ssh2 library path keeps its own algorithm list, which is independent
 * of the client OpenSSH version.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ServerHostKeyAlgorithm } from 'ssh2';

const execFileAsync = promisify(execFile);

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
 * SSH client identification string sent after `SSH-2.0-`. The ssh2 default
 * (`ssh2js1.x`) is unusual, and some NSG/gateway appliances whitelist known
 * SSH clients (OpenSSH, PuTTY/MobaXterm, SecureCRT…) while rejecting
 * unknown ones at the channel level (e.g. "Unable to start subsystem: sftp",
 * "Unable to request a pseudo-terminal"). Default to an OpenSSH banner;
 * override via the `safs.sshClientIdent` setting.
 */
export const defaultSshClientIdent = 'OpenSSH_9.6';

const legacyKeyTypes = ['ssh-rsa', 'ssh-dss'] as const;

/** Parses "OpenSSH_9.6p1" / "OpenSSH_for_Windows_9.5p2" into [major, minor]. */
export function parseSshVersion(versionLine: string): [number, number] | undefined {
  const match = /OpenSSH(?:_for_Windows)?_(\d+)\.(\d+)/.exec(versionLine);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

export interface SshCapabilities {
  sshPath: string;
  /** Parsed OpenSSH client version; undefined when `ssh -V` is unavailable. */
  version?: [number, number];
  /** Signature algorithms from `ssh -Q sig`; undefined when the query fails. */
  sigAlgorithms?: Set<string>;
  /** KEX algorithms from `ssh -Q kex`; undefined when the query fails. */
  kexAlgorithms?: Set<string>;
}

const capabilityCache = new Map<string, Promise<SshCapabilities>>();

/** Most recently probed client, used to build CLI args without extra awaits. */
let lastCapabilities: SshCapabilities | undefined;

async function detectSshCapabilities(
  sshPath: string, env?: NodeJS.ProcessEnv
): Promise<SshCapabilities> {
  const caps: SshCapabilities = { sshPath };
  try {
    const { stdout, stderr } = await execFileAsync(sshPath, ['-V'], {
      env: { ...process.env, ...env },
      windowsHide: true
    });
    caps.version = parseSshVersion(stderr) ?? parseSshVersion(stdout);
  } catch (error) {
    caps.version = parseSshVersion(error instanceof Error ? error.message : String(error));
  }
  try {
    const { stdout } = await execFileAsync(sshPath, ['-Q', 'sig'], {
      env: { ...process.env, ...env },
      windowsHide: true
    });
    caps.sigAlgorithms = new Set(
      stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    );
  } catch {
    caps.sigAlgorithms = undefined;
  }
  try {
    const { stdout } = await execFileAsync(sshPath, ['-Q', 'kex'], {
      env: { ...process.env, ...env },
      windowsHide: true
    });
    caps.kexAlgorithms = new Set(
      stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    );
  } catch {
    caps.kexAlgorithms = undefined;
  }
  return caps;
}

/**
 * Probes the OpenSSH client at `sshPath` (`ssh -V` and `ssh -Q sig`) and
 * caches the result. Never rejects: probing failures degrade to permissive
 * defaults that keep the previous behaviour.
 */
export function ensureSshCapabilities(
  sshPath: string, env?: NodeJS.ProcessEnv
): Promise<SshCapabilities> {
  const existing = capabilityCache.get(sshPath);
  if (existing) return existing;
  const probe = detectSshCapabilities(sshPath, env);
  capabilityCache.set(sshPath, probe);
  void probe.then((caps) => {
    lastCapabilities = caps;
  });
  return probe;
}

/**
 * OpenSSH `-o` arguments re-enabling legacy host key and user key algorithms
 * for a specific client. The `+` prefix appends to the client defaults, so
 * modern keys are kept.
 */
export function legacySshAlgorithmArgsFor(caps: SshCapabilities | undefined): string[] {
  const keyTypes = legacyKeyTypes.filter((keyType) => {
    if (caps?.sigAlgorithms) return caps.sigAlgorithms.has(keyType);
    // `-Q sig` unavailable: fall back to the version threshold. DSA was
    // removed from OpenSSH 10.0, where listing it is a syntax error.
    if (caps?.version && caps.version[0] >= 10) return keyType !== 'ssh-dss';
    return true;
  });
  const args = ['-o', `HostKeyAlgorithms=+${keyTypes.join(',')}`];
  // Only OpenSSH 8.5+ knows PubkeyAcceptedAlgorithms; older clients fail the
  // whole command with "Bad configuration option" (exit code 255). Older
  // clients do not need it either: ssh-rsa user keys were only disabled by
  // default in OpenSSH 8.8.
  const version = caps?.version;
  if (!version || version[0] > 8 || (version[0] === 8 && version[1] >= 5)) {
    args.push('-o', `PubkeyAcceptedAlgorithms=+${keyTypes.join(',')}`);
  }
  return args;
}

/**
 * Legacy algorithm args for the probed ssh client. Before the first probe
 * completes this keeps the previous permissive defaults.
 */
export function legacySshAlgorithmArgs(): string[] {
  return legacySshAlgorithmArgsFor(lastCapabilities);
}

/**
 * KEX algorithms in preference order: post-quantum first (suppresses the
 * OpenSSH 10+ "not using a post-quantum key exchange" warning on legacy
 * servers), then modern, then legacy group-exchange/group1 for old gateways.
 * Filtered by what the installed client actually supports (`ssh -Q kex`).
 */
const preferredKexAlgorithms = [
  'sntrup761x25519-sha512',
  'sntrup761x25519-sha512@openssh.com',
  'mlkem768x25519-sha256',
  'curve25519-sha256',
  'curve25519-sha256@libssh.org',
  'ecdh-sha2-nistp256',
  'ecdh-sha2-nistp384',
  'ecdh-sha2-nistp521',
  'diffie-hellman-group-exchange-sha256',
  'diffie-hellman-group14-sha256',
  'diffie-hellman-group16-sha512',
  'diffie-hellman-group18-sha512',
  'diffie-hellman-group-exchange-sha1',
  'diffie-hellman-group14-sha1',
  'diffie-hellman-group1-sha1'
];

/**
 * Returns `-o KexAlgorithms=…` for the probed client, or nothing when the
 * client cannot be queried (old OpenSSH, where no PQ warning exists anyway).
 * Setting the list explicitly suppresses OpenSSH 10+'s post-quantum warning
 * that would otherwise spam the terminal when connecting to legacy servers.
 */
export function kexAlgorithmsArgsFor(caps: SshCapabilities | undefined): string[] {
  const supported = caps?.kexAlgorithms;
  if (!supported) return [];
  const list = preferredKexAlgorithms.filter((algorithm) => supported.has(algorithm));
  if (list.length === 0) return [];
  return ['-o', `KexAlgorithms=${list.join(',')}`];
}

/** KEX algorithm args for the probed ssh client (no-op before the probe). */
export function kexAlgorithmsArgs(): string[] {
  return kexAlgorithmsArgsFor(lastCapabilities);
}
