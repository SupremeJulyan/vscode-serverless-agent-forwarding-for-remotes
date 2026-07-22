import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

export interface WindowsInstaller {
  name: string;
  fileName: string;
  url: string;
  sha256: string;
}

export const winFspInstaller: WindowsInstaller = {
  name: 'WinFsp 2.2.26194',
  fileName: 'winfsp-2.2.26194.msi',
  url: 'https://github.com/winfsp/winfsp/releases/download/v2.2B3/winfsp-2.2.26194.msi',
  sha256: '7b41020618cdcc33d699d0e15c1df660f0762a09b57080049c565857ac00bd9d'
};

export const sshfsWinInstaller: WindowsInstaller = {
  name: 'SSHFS-Win 3.7.21011 x64',
  fileName: 'sshfs-win-3.7.21011-x64.msi',
  url: 'https://github.com/winfsp/sshfs-win/releases/download/v3.7.21011/sshfs-win-3.7.21011-x64.msi',
  sha256: '76080d7bfb1ba0a807f8874d07388bec4bc30893f2da511d5cb7a16d4490f7d1'
};

export async function hasWindowsInstallDirectory(directoryName: string): Promise<boolean> {
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (!root) continue;
    try {
      if ((await stat(path.join(root, directoryName))).isDirectory()) return true;
    } catch {
      // Try the other standard Program Files root.
    }
  }
  return false;
}

export async function downloadInstaller(
  installer: WindowsInstaller, directory: string
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, installer.fileName);
  try {
    const existing = await readFile(destination);
    if (sha256(existing) === installer.sha256) return destination;
  } catch {
    // Download a fresh verified copy.
  }
  const response = await fetch(installer.url);
  if (!response.ok) throw new Error(`下载 ${installer.name} 失败：HTTP ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  if (sha256(content) !== installer.sha256) {
    throw new Error(`${installer.name} 安装包 SHA-256 校验失败`);
  }
  const temporary = `${destination}.download`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}

export function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function installMsiPackages(paths: string[]): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$packages = $env:SERVERLESS_REMOTE_INSTALLERS | ConvertFrom-Json
foreach ($package in $packages) {
  $process = Start-Process -FilePath 'msiexec.exe' -Verb RunAs -Wait -PassThru -ArgumentList @(
    '/i', ('"' + $package + '"'), '/passive', '/norestart'
  )
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    throw "MSI 安装失败，退出代码: $($process.ExitCode)"
  }
}
`;
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], {
    env: { ...process.env, SERVERLESS_REMOTE_INSTALLERS: JSON.stringify(paths) },
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
}
