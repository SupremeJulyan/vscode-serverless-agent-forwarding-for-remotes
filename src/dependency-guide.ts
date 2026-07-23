import { readFile } from 'node:fs/promises';
import { PlatformKind } from './platform';

export interface DependencyGuide {
  message: string;
  command?: string;
  url?: string;
  links?: Array<{ label: string; url: string }>;
}

interface Distribution {
  id: string;
  idLike: string[];
  name: string;
}

const bridgeRepository = 'https://github.com/SupremeJulyan/wsl-vpn-ssh-bridge';
const macFuseInstructions = 'https://github.com/macfuse/macfuse/wiki/File-Systems-%E2%80%90-SSHFS';
const macFuseDownload = 'https://macfuse.github.io/';
const winFspDownload = 'https://github.com/winfsp/winfsp/releases/latest';
const sshfsWinDownload = 'https://github.com/winfsp/sshfs-win/releases/latest';

export function parseOsRelease(contents: string): Distribution {
  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    values.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  const id = (values.get('ID') ?? 'unknown').toLowerCase();
  return {
    id,
    idLike: (values.get('ID_LIKE') ?? '').toLowerCase().split(/\s+/).filter(Boolean),
    name: values.get('PRETTY_NAME') ?? values.get('NAME') ?? id
  };
}

function distributionCommand(distribution: Distribution, wsl: boolean): string | undefined {
  const family = new Set([distribution.id, ...distribution.idLike]);
  const packages = wsl
    ? {
        debian: 'openssh-client python3 util-linux openssl sshfs git',
        fedora: 'openssh-clients python3 util-linux openssl fuse-sshfs git',
        arch: 'openssh python util-linux openssl sshfs git',
        suse: 'openssh-clients python3 util-linux openssl sshfs git',
        alpine: 'openssh-client python3 util-linux openssl sshfs git'
      }
    : {
        debian: 'openssh-client sshfs fuse3 util-linux',
        fedora: 'openssh-clients fuse-sshfs fuse3 util-linux',
        arch: 'openssh sshfs fuse3 util-linux',
        suse: 'openssh-clients sshfs fuse3 util-linux',
        alpine: 'openssh-client sshfs fuse3 util-linux'
      };

  if (family.has('debian') || family.has('ubuntu')) {
    return `sudo apt update && sudo apt install -y ${packages.debian}`;
  }
  if (family.has('fedora') || family.has('rhel') || family.has('centos')) {
    return `sudo dnf install -y ${packages.fedora}`;
  }
  if (family.has('arch') || family.has('manjaro')) {
    return `sudo pacman -S --needed ${packages.arch}`;
  }
  if (family.has('suse') || family.has('opensuse')) {
    return `sudo zypper install -y ${packages.suse}`;
  }
  if (family.has('alpine')) {
    return `sudo apk add ${packages.alpine}`;
  }
  return undefined;
}

export async function createDependencyGuide(
  platform: PlatformKind, missing: string[], osReleasePath = '/etc/os-release'
): Promise<DependencyGuide | undefined> {
  if (missing.length === 0) return undefined;
  if (platform === 'windows') {
    const links: Array<{ label: string; url: string }> = [];
    if (missing.includes('WinFsp')) links.push({ label: '下载 WinFsp', url: winFspDownload });
    if (missing.includes('SSHFS-Win')) links.push({ label: '下载 SSHFS-Win', url: sshfsWinDownload });
    return {
      message: `Serverless Remote SSH 缺少：${missing.join('、')}。Windows 必须安装 OpenSSH Client、WinFsp 和 SSHFS-Win。`,
      links
    };
  }
  if (platform === 'macos') {
    return {
      message: `Serverless Remote SSH 缺少 ${missing.join('、')}。请安装 macFUSE SSHFS。`,
      url: macFuseInstructions,
      links: [
        { label: '下载 macFUSE', url: macFuseDownload },
        { label: '下载 SSHFS', url: macFuseInstructions }
      ]
    };
  }

  let distribution: Distribution;
  try {
    distribution = parseOsRelease(await readFile(osReleasePath, 'utf8'));
  } catch {
    distribution = { id: 'unknown', idLike: [], name: '当前 Linux 发行版' };
  }
  const systemCommand = distributionCommand(distribution, platform === 'wsl');
  if (!systemCommand) {
    return {
      message: `Serverless Remote SSH 缺少 ${missing.join('、')}。未识别 ${distribution.name} 的包管理器，请手动安装所需软件。`,
      url: platform === 'wsl' ? bridgeRepository : undefined
    };
  }
  if (platform === 'linux') {
    return {
      message: `Serverless Remote SSH 缺少 ${missing.join('、')}。可在 ${distribution.name} 的终端运行安装命令。`,
      command: systemCommand
    };
  }

  const needsBridge = missing.some((item) => item === 'ssh-bridge' || item === 'sshfs-bridge');
  const bridgeCommand = `git clone ${bridgeRepository}.git && cd wsl-vpn-ssh-bridge && ./install.sh`;
  return {
    message: `Serverless Remote SSH 缺少 ${missing.join('、')}。可在 ${distribution.name} 的 WSL 终端运行安装命令。`,
    command: needsBridge ? `${systemCommand} && ${bridgeCommand}` : systemCommand,
    url: needsBridge ? bridgeRepository : undefined
  };
}
