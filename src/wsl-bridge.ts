import * as path from 'node:path';

let bundleRoot: string | undefined;

/**
 * Set the absolute filesystem path to the directory that contains the bundled
 * WSL helper scripts (ssh-bridge, vpn-relay-pool.sh, …).
 *
 * Call once during activation with
 * `vscode.Uri.joinPath(context.extensionUri, 'resources', 'wsl').fsPath`.
 */
export function setWslBundlePath(resolvedPath: string): void {
  bundleRoot = resolvedPath;
}

/**
 * Returns the absolute path to the bundled ssh-bridge script.
 */
export function sshBridgePath(): string {
  if (!bundleRoot) throw new Error('WSL bundle path not initialised');
  return path.join(bundleRoot, 'ssh-bridge');
}
