import * as os from 'node:os';
import * as path from 'node:path';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { PlatformKind } from './platform';

export interface AskpassCredentials {
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

const unixHelperScript = `#!/bin/sh
secret_file="$SERVERLESS_REMOTE_ASKPASS_FILE"
if [ -z "$secret_file" ] || [ ! -f "$secret_file" ]; then
  exit 1
fi
case "$1" in
  *[Pp]assword*) ;;
  *) exit 1 ;;
esac
/bin/cat "$secret_file"
/bin/rm -f "$secret_file" "$0"
/bin/rmdir "$(dirname "$secret_file")" 2>/dev/null || true
`;

const windowsHelperScript = `@echo off
setlocal
if not defined SERVERLESS_REMOTE_ASKPASS_FILE exit /b 1
if not exist "%SERVERLESS_REMOTE_ASKPASS_FILE%" exit /b 1
if defined SERVERLESS_REMOTE_ASKPASS_MARKER >"%SERVERLESS_REMOTE_ASKPASS_MARKER%" echo invoked
echo.%*|findstr /i "password">nul
if errorlevel 1 exit /b 1
type "%SERVERLESS_REMOTE_ASKPASS_FILE%"
del /f /q "%SERVERLESS_REMOTE_ASKPASS_FILE%" 2>nul
del /f /q "%~f0" 2>nul
`;

export function platformUsesAskpass(platform: PlatformKind): boolean {
  return platform === 'macos' || platform === 'linux'
    || platform === 'wsl' || platform === 'windows';
}

export async function createAskpassCredentials(password: string): Promise<AskpassCredentials> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-askpass-'));
  const passwordPath = path.join(directory, 'password');
  const markerPath = path.join(directory, 'invoked');
  const win32 = process.platform === 'win32';
  // Windows OpenSSH and VS Code Remote-SSH conventionally invoke a .bat
  // helper. Keep the same form instead of relying on .cmd association details.
  const helperName = win32 ? 'askpass.bat' : 'askpass.sh';
  const helperPath = path.join(directory, helperName);
  const helperContent = win32 ? windowsHelperScript : unixHelperScript;
  await chmod(directory, 0o700);
  await writeFile(passwordPath, password, { encoding: 'utf8', mode: 0o600 });
  await writeFile(helperPath, helperContent, { encoding: 'utf8', mode: 0o700 });
  return {
    env: {
      SSH_ASKPASS: helperPath,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || 'safs',
      SERVERLESS_REMOTE_ASKPASS_FILE: passwordPath,
      ...(win32 ? { SERVERLESS_REMOTE_ASKPASS_MARKER: markerPath } : {})
    },
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
