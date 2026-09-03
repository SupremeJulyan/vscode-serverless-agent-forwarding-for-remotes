import * as path from 'node:path';

export const remoteFileSystemScheme = 'safs';

export interface RemoteUriLocation {
  mountName: string;
  remotePath: string;
}

function encodeMountAuthority(mountName: string): string {
  if (!mountName) throw new Error('Remote folder name must not be empty');
  // URI authorities are case-insensitive and URL parsers normalize hostnames
  // to lowercase. Use the plain mount name when it already is a safe,
  // lowercase authority so VS Code shows the config name directly in the
  // status-bar/remote indicator; fall back to lowercase hexadecimal for
  // anything else so the identifier survives that normalization.
  if (/^[a-z0-9][a-z0-9._-]*$/.test(mountName)) return mountName;
  return `m-${Buffer.from(mountName, 'utf8').toString('hex')}`;
}

function decodeMountAuthority(authority: string): string {
  if (authority.startsWith('m-')) {
    const encoded = authority.slice(2);
    if (encoded && encoded.length % 2 === 0 && /^[0-9a-f]+$/.test(encoded)) {
      // Legacy format: lowercase-hex encoded mount name. All URIs created
      // before the plain-name change use this form, so decode it
      // unconditionally (a plain mount literally named "m-<hex>" is
      // pathological and out of scope).
      return Buffer.from(encoded, 'hex').toString('utf8');
    }
  }
  return authority;
}

export function normalizeRemotePath(remotePath: string): string {
  if (!remotePath.startsWith('/')) {
    throw new Error(`Remote URI paths must be absolute: ${remotePath}`);
  }
  return path.posix.normalize(remotePath);
}

/**
 * Validate one filename returned by a remote directory listing before it is
 * joined to either a remote or local parent. SFTP servers control this string;
 * a malicious implementation may return separators even though POSIX
 * filenames cannot contain '/'. Backslashes are rejected as well because they
 * become separators when the same name is materialized on Windows.
 */
export function assertSafeRemoteEntryName(name: string): void {
  if (!name || name === '.' || name === '..' || /[\0/\\]/.test(name)) {
    throw new Error(`Unsafe remote directory entry name: ${JSON.stringify(name)}`);
  }
}

function encodeRemotePath(remotePath: string): string {
  return normalizeRemotePath(remotePath)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function decodeRemotePath(pathname: string): string {
  try {
    return normalizeRemotePath(
      pathname.split('/').map((segment) => decodeURIComponent(segment)).join('/')
    );
  } catch (error) {
    if (error instanceof URIError) throw new Error(`Invalid remote URI path: ${pathname}`);
    throw error;
  }
}

/**
 * Produces a URI safe for use as a VS Code workspace folder. The authority is
 * an opaque, reversible mount identifier so names containing spaces, Unicode,
 * or host-like punctuation do not leak into URI parsing rules.
 */
export function remoteUri(mountName: string, remotePath: string): string {
  return `${remoteFileSystemScheme}://${encodeMountAuthority(mountName)}${
    encodeRemotePath(remotePath)
  }`;
}

export function parseRemoteUri(value: string): RemoteUriLocation {
  const parsed = new URL(value);
  if (parsed.protocol !== `${remoteFileSystemScheme}:`) {
    throw new Error(`Unsupported remote URI scheme: ${parsed.protocol.slice(0, -1)}`);
  }
  // VS Code media previews append cache-busting query/fragment data to custom
  // filesystem URIs. They are not part of the remote filename and must be
  // ignored, just like FileSystemProvider implementations ignore URI metadata.
  if (parsed.username || parsed.password || parsed.port) {
    throw new Error(`Invalid remote workspace URI: ${value}`);
  }
  return {
    mountName: decodeMountAuthority(parsed.hostname),
    remotePath: decodeRemotePath(parsed.pathname)
  };
}

export function isRemotePathInsideRoot(remoteRoot: string, candidate: string): boolean {
  const normalizedRoot = normalizeRemotePath(remoteRoot);
  const normalizedCandidate = normalizeRemotePath(candidate);
  const relative = path.posix.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!relative.startsWith('../') && relative !== '..');
}

/**
 * A configured "." cannot be represented in a workspace URI until SFTP has
 * resolved the login directory. Other relative paths are likewise resolved by
 * the server through realpath before this helper is called.
 */
export function resolvedRemoteRoot(configuredPath: string, realPath: string): string {
  if (!realPath.startsWith('/')) {
    throw new Error(`SFTP realpath must return an absolute path: ${realPath}`);
  }
  if (configuredPath === '.' || !configuredPath.startsWith('/')) {
    return normalizeRemotePath(realPath);
  }
  return normalizeRemotePath(configuredPath);
}
