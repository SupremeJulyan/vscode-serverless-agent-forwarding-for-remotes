import { existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const wslBridgeUninstallScript = '.wsl-vpn-bridge-uninstall.sh';

export function runWslBridgeUninstall(
  home = homedir(),
  run = spawnSync
): number {
  const script = join(home, wslBridgeUninstallScript);
  if (!existsSync(script)) return 0;

  const result = run('/bin/bash', [script], { stdio: 'inherit' });
  if (result.error) {
    console.error(`Failed to run ${script}: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) return result.status ?? 1;

  unlinkSync(script);
  return 0;
}

if (require.main === module) {
  process.exitCode = runWslBridgeUninstall();
}
