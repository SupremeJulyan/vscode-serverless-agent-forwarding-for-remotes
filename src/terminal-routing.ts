import type { HostConfig } from './config';
import type { PlatformKind } from './platform';

/**
 * Prefer the in-extension ssh2 terminal when it can connect directly. Its
 * host verifier sees the key on the connection that becomes the terminal, so
 * there is no ssh-keyscan/actual-ssh race on first use or rotating backends.
 */
export function shouldUseBuiltinSshTerminal(
  kind: PlatformKind, host: HostConfig, forceSystemSsh = false
): boolean {
  return !forceSystemSsh
    && Boolean(host.password)
    && !host.private_key_path
    && !(kind === 'wsl' && host.vpn === true);
}
