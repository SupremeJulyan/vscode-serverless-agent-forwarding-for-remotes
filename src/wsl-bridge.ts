import * as path from 'node:path';
import { chmod } from 'node:fs/promises';

let bundleRoot: string | undefined;

/**
 * Set the absolute filesystem path to the directory that contains the bundled
 * Bundled WSL bridge and VPN relay scripts.
 *
 * Call once during activation with
 * `vscode.Uri.joinPath(context.extensionUri, 'resources', 'wsl').fsPath`.
 */
export function setWslBundlePath(resolvedPath: string): void {
  bundleRoot = resolvedPath;
}

/**
 * Make sure the bundled ssh-bridge script is executable.
 *
 * VS Code spawns the bridge directly as the terminal shell. VSIX packages
 * created on Windows (or via checkouts that lost the git exec bit) store the
 * script with mode 0666, which makes the spawn fail with EACCES — the remote
 * folder still opens because SFTP never touches the bridge. Re-assert 0755 at
 * activation so terminals work regardless of how the extension was packaged.
 */
export async function ensureWslBridgeExecutable(): Promise<void> {
  if (!bundleRoot) throw new Error('WSL bundle path not initialised');
  try {
    await chmod(path.join(bundleRoot, 'ssh-bridge'), 0o755);
  } catch {
    // Never block activation: on non-POSIX hosts chmod may be a no-op, and
    // if the script is already executable this call does nothing anyway.
  }
}

/**
 * Returns the absolute path to the bundled ssh-bridge script.
 */
export function sshBridgePath(): string {
  if (!bundleRoot) throw new Error('WSL bundle path not initialised');
  return path.join(bundleRoot, 'ssh-bridge');
}

/**
 * Returns the absolute path to the bundled VPN relay pool helper.
 */
export function vpnRelayPoolPath(): string {
  if (!bundleRoot) throw new Error('WSL bundle path not initialised');
  return path.join(bundleRoot, 'vpn-relay-pool.sh');
}
