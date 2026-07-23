import * as path from 'node:path';
import { MountConfig } from './config';
import { PlatformKind } from './platform';

export interface MountPathMatch {
  mount: MountConfig;
  localPath: string;
  cwd: string;
}

function pathIsInside(candidate: string, parent: string, caseInsensitive: boolean): boolean {
  const relative = path.relative(parent, candidate);
  const compared = caseInsensitive ? relative.toLowerCase() : relative;
  return compared === '' || (!compared.startsWith('..') && !path.isAbsolute(relative));
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
