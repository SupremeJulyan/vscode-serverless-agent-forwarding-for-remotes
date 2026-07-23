import * as path from 'node:path';
import { MountConfig } from './config';
import { PlatformKind } from './platform';

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
  const compared = platform === 'windows' ? relative.toLowerCase() : relative;
  if (compared.startsWith('..') || localPath.isAbsolute(relative)) return undefined;
  if (!relative) return path.posix.normalize(remoteRoot);
  return path.posix.join(remoteRoot, ...relative.split(localPath.sep));
}

export function findMountForPath(
  mounts: MountConfig[], candidatePath: string, platform: PlatformKind,
  expand: (value: string) => string
): MountPathMatch | undefined {
  const candidate = path.resolve(candidatePath);
  const caseInsensitive = platform === 'windows';
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
