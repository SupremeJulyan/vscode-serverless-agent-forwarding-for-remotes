import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { commandExists } from './process';

export interface InstallReporter {
  log(message: string): void;
  progress(message: string, increment?: number): void;
}

interface Distribution {
  id: string;
  idLike: string[];
  name: string;
}

const requiredWslCommands = ['flock'] as const;

export function parseOsRelease(contents: string): Distribution {
  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return {
    id: (values.get('ID') ?? 'unknown').toLowerCase(),
    idLike: (values.get('ID_LIKE') ?? '').toLowerCase().split(/\s+/).filter(Boolean),
    name: values.get('PRETTY_NAME') ?? values.get('NAME') ?? '当前 WSL 发行版'
  };
}

export function wslDependencyCommand(distribution: Distribution): string | undefined {
  const family = new Set([distribution.id, ...distribution.idLike]);
  if (family.has('debian') || family.has('ubuntu')) {
    return 'apt update && apt install -y util-linux';
  }
  if (family.has('fedora') || family.has('rhel') || family.has('centos')) {
    return 'dnf install -y util-linux';
  }
  if (family.has('arch') || family.has('manjaro')) {
    return 'pacman -S --needed --noconfirm util-linux';
  }
  if (family.has('suse') || family.has('opensuse')) {
    return 'zypper --non-interactive install util-linux';
  }
  if (family.has('alpine')) {
    return 'apk add util-linux';
  }
  return undefined;
}

export async function hasRequiredWslDependencies(): Promise<boolean> {
  const installed = await Promise.all(requiredWslCommands.map(commandExists));
  return installed.every(Boolean);
}

function run(command: string, args: string[], reporter: InstallReporter): Promise<void> {
  reporter.log(`$ ${command} ${args.join(' ')}`);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk: Buffer) => reporter.log(chunk.toString().trimEnd()));
    child.stderr.on('data', (chunk: Buffer) => reporter.log(chunk.toString().trimEnd()));
    child.once('error', reject);
    child.once('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`依赖安装命令退出，代码 ${code ?? 'unknown'}`)));
  });
}

export async function installWslDependencies(reporter: InstallReporter): Promise<void> {
  const distribution = parseOsRelease(await readFile('/etc/os-release', 'utf8'));
  const installCommand = wslDependencyCommand(distribution);
  if (!installCommand) {
    throw new Error(`未识别 ${distribution.name} 的包管理器，请手动安装 util-linux`);
  }

  const wsl = '/mnt/c/Windows/System32/wsl.exe';
  const distro = process.env.WSL_DISTRO_NAME;
  reporter.progress(`正在为 ${distribution.name} 安装 util-linux…`, 20);
  await run(wsl, [
    ...(distro ? ['-d', distro] : []),
    '-u', 'root', '--', 'sh', '-lc', installCommand
  ], reporter);
  reporter.progress('依赖安装完成', 80);
}
