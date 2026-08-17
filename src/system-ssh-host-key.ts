import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HostConfig } from './config';
import {
  defaultPrompts, HostKeyChangedAction, HostKeyPrompts,
  sha256Fingerprint, TrustStore, verifyHostKeyWithPrompt
} from './host-key';
import { PlatformKind } from './platform';
import { resolveExecutable } from './process';
import { ensureSshCapabilities } from './ssh-algorithms';
import { sshBridgePath } from './wsl-bridge';

/**
 * 系统 ssh 路径（WSL/Linux/macOS/Windows 非内置通道）的主机密钥校验：
 * 系统 ssh 无法弹 VS Code 对话框，因此由扩展在连接前用 ssh-keyscan 探测
 * 当前后端密钥，与信任台账比对；未受信任时弹 MobaXterm 风格对话框
 * （首次连接信任 / 密钥变化三选：接受、拒绝、保存为附加密钥）。
 * 校验通过后再以 known_hosts 空设备参数启动 ssh（见 platform.ts），
 * 系统 ssh 本身不再做二次检查。
 */

const execFileAsync = promisify(execFile);

export interface HostKeyProbeResult {
  /** 探测是否成功；false 时调用方按“跳过校验继续连接”降级（不阻断已有流程）。 */
  probed: boolean;
  /** 探测到的服务器密钥指纹（可能多个算法各一个）。 */
  fingerprints: string[];
  error?: string;
}

export type HostKeyProbe = (
  host: HostConfig, platformKind: PlatformKind,
  log?: (message: string) => void, env?: NodeJS.ProcessEnv
) => Promise<HostKeyProbeResult>;

/** ssh-keyscan 输出（每行 "host type base64"，注释行以 # 开头）解析为去重指纹集合。 */
export function parseKeyscanOutput(stdout: string): string[] {
  const fingerprints = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^\S+\s+\S+\s+(\S+)\s*$/.exec(trimmed);
    if (!match) continue;
    const encoded = match[1];
    // 严格 base64 校验：Node 的宽松解码会忽略非法字符，导致垃圾行被误判为密钥。
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) continue;
    try {
      const blob = Buffer.from(encoded, 'base64');
      if (blob.length === 0) continue;
      fingerprints.add(sha256Fingerprint(blob));
    } catch {
      // 忽略无法解析的行（注释等）。
    }
  }
  return [...fingerprints];
}

/** ssh-keyscan -t 列表：按客户端能力过滤（OpenSSH 10 移除了 ssh-dss）。 */
function keyscanKeyTypes(
  caps: Awaited<ReturnType<typeof ensureSshCapabilities>>
): string[] {
  const types = [
    'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521', 'ssh-rsa'
  ];
  if (!caps.version || caps.version[0] < 10) types.push('ssh-dss');
  return types;
}

async function probeNative(
  host: HostConfig, _platformKind: PlatformKind, log?: (message: string) => void
): Promise<HostKeyProbeResult> {
  const keyscanPath = await resolveExecutable('ssh-keyscan');
  const caps = await ensureSshCapabilities(await resolveExecutable('ssh'));
  try {
    const { stdout } = await execFileAsync(keyscanPath, [
      '-T', '6', '-p', String(host.port ?? 22),
      '-t', keyscanKeyTypes(caps).join(','), host.ip
    ], { timeout: 10_000, windowsHide: true });
    const fingerprints = parseKeyscanOutput(stdout);
    if (fingerprints.length === 0) {
      return { probed: false, fingerprints, error: 'ssh-keyscan 未返回任何主机密钥' };
    }
    log?.(`ssh-keyscan 探测 ${host.ip}:${host.port ?? 22} 成功`);
    return { probed: true, fingerprints };
  } catch (error) {
    return {
      probed: false, fingerprints: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function probeViaBridge(
  host: HostConfig, _platformKind: PlatformKind,
  log?: (message: string) => void, env?: NodeJS.ProcessEnv
): Promise<HostKeyProbeResult> {
  try {
    const { stdout } = await execFileAsync(sshBridgePath(), ['probe', host.name], {
      timeout: 20_000, windowsHide: true,
      env: { ...process.env, ...env }
    });
    const fingerprints: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.startsWith('PROBE_OK ')) continue;
      const blob = Buffer.from(line.slice('PROBE_OK '.length).trim(), 'base64');
      if (blob.length > 0) fingerprints.push(sha256Fingerprint(blob));
    }
    if (fingerprints.length === 0) {
      return { probed: false, fingerprints, error: 'ssh-bridge probe 未返回主机密钥' };
    }
    log?.(`ssh-bridge probe ${host.name} 成功`);
    return { probed: true, fingerprints };
  } catch (error) {
    return {
      probed: false, fingerprints: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

const probeCache = new Map<string, { at: number; result: HostKeyProbeResult }>();
const probeCacheTtlMs = 30_000;

/** 探测主机当前密钥（带 30s 内存缓存，避免终端+命令执行连续探测）。 */
export async function probeHostKey(
  host: HostConfig, platformKind: PlatformKind,
  log?: (message: string) => void, env?: NodeJS.ProcessEnv
): Promise<HostKeyProbeResult> {
  const cacheKey = `${host.ip}:${host.port ?? 22}`;
  const cached = probeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < probeCacheTtlMs) {
    return cached.result;
  }
  const probe = platformKind === 'wsl' ? probeViaBridge : probeNative;
  const result = await probe(host, platformKind, log, env);
  probeCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

export interface HostKeyVerification {
  ok: boolean;
  reason?: string;
}

/**
 * 系统 ssh 路径连接前的主机密钥校验（仅 prompt 模式执行；accept/reject
 * 沿用 platform.ts 的 known_hosts 映射，不做预检）。
 *
 * 决策统一走 host-key.ts 的 verifyHostKeyWithPrompt（与内置 ssh2 通道共用），
 * 具备并发去重与本会话不重复弹窗语义。
 *
 * @param probe   可注入的探测实现（测试用）
 * @param prompts 可注入的弹窗实现（测试用，默认走 host-key 的 MobaXterm 风格弹窗）
 */
export async function verifySystemSshHostKey(
  store: TrustStore,
  action: HostKeyChangedAction,
  host: HostConfig,
  platformKind: PlatformKind,
  log?: (message: string) => void,
  probe: HostKeyProbe = probeHostKey,
  prompts: HostKeyPrompts = defaultPrompts,
  env?: NodeJS.ProcessEnv
): Promise<HostKeyVerification> {
  if (action !== 'prompt') {
    return { ok: true };
  }
  const result = await probe(host, platformKind, log, env);
  if (!result.probed) {
    log?.(`主机密钥探测失败（${host.name}）：${result.error ?? '未知错误'} — 跳过校验继续连接`);
    return { ok: true };
  }
  const allowed = await verifyHostKeyWithPrompt(store, host, result.fingerprints, log, prompts);
  if (!allowed) {
    return {
      ok: false,
      reason: `已拒绝接受主机"${host.name}"的新 SSH 主机密钥（指纹：${result.fingerprints.join(', ')}）`
    };
  }
  return { ok: true };
}
