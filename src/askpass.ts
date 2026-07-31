import * as os from 'node:os';
import * as path from 'node:path';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { PlatformKind } from './platform';

export interface AskpassCredentials {
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

const helperScript = `#!/bin/sh
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

export function platformUsesAskpass(platform: PlatformKind): boolean {
  return platform === 'macos' || platform === 'linux';
}

export async function createAskpassCredentials(password: string): Promise<AskpassCredentials> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverless-remote-askpass-'));
  const passwordPath = path.join(directory, 'password');
  const helperPath = path.join(directory, 'askpass.sh');
  await chmod(directory, 0o700);
  await writeFile(passwordPath, password, { encoding: 'utf8', mode: 0o600 });
  await writeFile(helperPath, helperScript, { encoding: 'utf8', mode: 0o700 });
  return {
    env: {
      SSH_ASKPASS: helperPath,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || 'serverless-remote-ssh',
      SERVERLESS_REMOTE_ASKPASS_FILE: passwordPath
    },
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
