import * as path from 'node:path';
import { MountConfig } from './config';
import { PlatformKind } from './platform';

export function defaultMountDirectory(
  mount: MountConfig, currentDirectory: string, platform: PlatformKind
): string {
  if (platform === 'windows') return 'R:\\';
  const current = path.resolve(currentDirectory);
  return path.basename(current) === mount.name ? current : path.join(current, mount.name);
}

export function resolveMountDirectory(
  mount: MountConfig, currentDirectory: string, platform: PlatformKind,
  expand: (value: string) => string
): string {
  const configured = mount.local_paths?.[platform] ?? mount.local_path;
  return configured
    ? expand(configured)
    : defaultMountDirectory(mount, currentDirectory, platform);
}

export function mountPathInDirectory(
  directory: string, mountName: string, platform: PlatformKind
): string {
  return pathApi(platform).join(directory, mountName);
}

export interface MountPathMatch {
  mount: MountConfig;
  localPath: string;
  cwd: string;
}

function pathApi(platform: PlatformKind): typeof path.posix | typeof path.win32 {
  return platform === 'windows' ? path.win32 : path.posix;
}

function pathIsInside(candidate: string, parent: string, caseInsensitive: boolean): boolean {
  const relative = path.relative(parent, candidate);
  const compared = caseInsensitive ? relative.toLowerCase() : relative;
  return compared === '' || (!compared.startsWith('..') && !path.isAbsolute(relative));
}

export function remotePathForLocalPath(
  remoteRoot: string, localRoot: string, localCwd: string, platform: PlatformKind
): string | undefined {
  const localPath = pathApi(platform);
  const root = localPath.resolve(localRoot);
  const cwd = localPath.resolve(localCwd);
  const relative = localPath.relative(root, cwd);
  const compared = platform === 'windows' || platform === 'macos' ? relative.toLowerCase() : relative;
  if (compared.startsWith('..') || localPath.isAbsolute(relative)) return undefined;
  if (!relative) return path.posix.normalize(remoteRoot);
  return path.posix.join(remoteRoot, ...relative.split(localPath.sep));
}

export function findMountForPath(
  mounts: MountConfig[], candidatePath: string, platform: PlatformKind,
  expand: (value: string) => string
): MountPathMatch | undefined {
  const candidate = path.resolve(candidatePath);
  const caseInsensitive = platform === 'windows' || platform === 'macos';
  return mounts
    .flatMap((mount) => {
      const configured = mount.local_paths?.[platform] ?? mount.local_path;
      if (!configured) return [];
      const localPath = path.resolve(expand(configured));
      return pathIsInside(candidate, localPath, caseInsensitive)
        ? [{ mount, localPath, cwd: candidate }]
        : [];
    })
    .sort((left, right) => right.localPath.length - left.localPath.length)[0];
}

export function findMountForPaths(
  mounts: MountConfig[], candidatePaths: string[], platform: PlatformKind,
  expand: (value: string) => string
): MountPathMatch | undefined {
  for (const candidatePath of candidatePaths) {
    const match = findMountForPath(mounts, candidatePath, platform, expand);
    if (match) return match;
  }
  return undefined;
}
