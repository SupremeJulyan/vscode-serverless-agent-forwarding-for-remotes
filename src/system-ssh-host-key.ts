import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HostConfig } from './config';
import {
  appendKnownHostsFile, appendLoadBalancedKnownHostsFile, defaultPrompts,
  getKnownHostsFilePath,
  HostKeyChangedAction, HostKeyPrompts, ProbedHostKey,
  replaceKnownHostsForHost, sha256Fingerprint, verifyHostKeyWithPrompt
} from './host-key';
import { PlatformKind } from './platform';
import { resolveExecutable } from './process';
import { ensureSshCapabilities } from './ssh-algorithms';
import { sshBridgePath } from './wsl-bridge';

/**
 * 系统 ssh 路径（WSL/Linux/macOS/Windows 非内置通道）的主机密钥校验：
 * 系统 ssh 无法弹 VS Code 对话框，因此由扩展在连接前用 ssh-keyscan 探测
 * 当前后端密钥，与扩展 known_hosts 文件比对；未确认时弹对话框
 * （首次连接 / 每次新密钥：接受、拒绝）。
 *
 * 确认通过后把探测到的密钥写入扩展独立的 known_hosts 文件，随后系统
 * ssh 以 `StrictHostKeyChecking=yes` + 该文件启动（见 platform.ts）：
 * OpenSSH 原生校验作为最后一道兜底——即使扩展弹窗逻辑出错，
 * 文件里没有的密钥也会被 OpenSSH 拒绝，不再是无校验裸奔。
 */

const execFileAsync = promisify(execFile);

export interface HostKeyProbeResult {
  /** 探测是否成功；false 时调用方按“跳过校验继续连接”降级（不阻断已有流程）。 */
  probed: boolean;
  /** 探测到的服务器密钥指纹（可能多个算法各一个）。 */
  fingerprints: string[];
  /** 原始密钥行（写扩展 known_hosts 文件用）；探测失败时为 undefined。 */
  keys?: ProbedHostKey[];
  error?: string;
}

export type HostKeyProbe = (
  host: HostConfig, platformKind: PlatformKind,
  log?: (message: string) => void, env?: NodeJS.ProcessEnv
) => Promise<HostKeyProbeResult>;

/**
 * ssh-keyscan 输出（每行 "host type base64"，注释行以 # 开头）解析为密钥行。
 */
export function parseKeyscanLines(stdout: string): ProbedHostKey[] {
  const keys: ProbedHostKey[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(trimmed);
    if (!match) continue;
    const [, host, type, encoded] = match;
    // 严格 base64 校验：Node 的宽松解码会忽略非法字符，导致垃圾行被误判为密钥。
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) continue;
    try {
      const blob = Buffer.from(encoded, 'base64');
      if (blob.length === 0) continue;
      const dedupeKey = `${type}:${encoded}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      keys.push({ host, type, blob: encoded });
    } catch {
      // 忽略无法解析的行（注释等）。
    }
  }
  return keys;
}

/** ssh-keyscan 输出解析为去重指纹集合（兼容旧调用）。 */
export function parseKeyscanOutput(stdout: string): string[] {
  return parseKeyscanLines(stdout).map((key) => sha256Fingerprint(Buffer.from(key.blob, 'base64')));
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
      '-T', '15', '-p', String(host.port ?? 22),
      '-t', keyscanKeyTypes(caps).join(','), host.ip
    ], { timeout: 25_000, windowsHide: true });
    const keys = parseKeyscanLines(stdout);
    if (keys.length === 0) {
      return { probed: false, fingerprints: [], error: 'ssh-keyscan 未返回任何主机密钥' };
    }
    log?.(`ssh-keyscan 探测 ${host.ip}:${host.port ?? 22} 成功`);
    return {
      probed: true,
      fingerprints: keys.map((key) => sha256Fingerprint(Buffer.from(key.blob, 'base64'))),
      keys
    };
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
      timeout: 30_000, windowsHide: true,
      env: { ...process.env, ...env }
    });
    // 行格式：PROBE_OK <host> <type> <blob>（host 与连接时 HostKeyAlias 一致）。
    const keys: ProbedHostKey[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^PROBE_OK (\S+) (\S+) (\S+)\s*$/.exec(line.trim());
      if (!match) continue;
      const [, probeHost, type, encoded] = match;
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) continue;
      const blob = Buffer.from(encoded, 'base64');
      if (blob.length === 0) continue;
      keys.push({ host: probeHost, type, blob: encoded });
    }
    if (keys.length === 0) {
      return { probed: false, fingerprints: [], error: 'ssh-bridge probe 未返回主机密钥' };
    }
    log?.(`ssh-bridge probe ${host.name} 成功`);
    return {
      probed: true,
      fingerprints: keys.map((key) => sha256Fingerprint(Buffer.from(key.blob, 'base64'))),
      keys
    };
  } catch (error) {
    return {
      probed: false, fingerprints: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * 探测主机当前密钥。安全决策不缓存：负载切换或服务器刚换钥时，旧结果会让
 * 随后的 StrictHostKeyChecking=yes 校验失败。瞬时失败自动重试一次。
 */
export async function probeHostKey(
  host: HostConfig, platformKind: PlatformKind,
  log?: (message: string) => void, env?: NodeJS.ProcessEnv
): Promise<HostKeyProbeResult> {
  const probe = platformKind === 'wsl' ? probeViaBridge : probeNative;
  let result = await probe(host, platformKind, log, env);
  if (!result.probed) {
    log?.(`主机密钥首次探测失败，将重试：${result.error ?? '未知错误'}`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    result = await probe(host, platformKind, log, env);
  }
  return result;
}

export interface HostKeyVerification {
  ok: boolean;
  reason?: string;
}

/** 负载节点在预检与实际连接之间切换时，最多重新探测并重试的次数。 */
export const maxOpenSshHostKeyRetries = 3;

/** 仅识别 OpenSSH 的严格主机密钥校验错误，认证/网络/远端命令失败不重试。 */
export function isOpenSshHostKeyVerificationFailure(message: string): boolean {
  const patterns = [
    /host\s+key\s+verification\s+failed/i,
    /remote\s+host\s+identification\s+has\s+changed/i,
    /no\s+\S+\s+host\s+key\s+is\s+known\s+for[\s\S]*strict\s+checking/i,
    /offending\s+\S+\s+host\s+key/i,
    /host\s+key\s+for\s+\S+[\s\S]*has\s+changed/i
  ];
  return patterns.some((pattern) => pattern.test(message));
}

/**
 * OpenSSH 因负载节点换钥而严格拒绝时，刷新信任记录并重试。每次刷新仍走
 * 正常指纹弹窗；达到上限后原样返回失败，避免不稳定地址造成无限重连。
 */
export async function runWithOpenSshHostKeyRetry<
  T extends { exitCode: number; stderr: string }
>(
  run: () => Promise<T>, refreshTrust: () => Promise<void>,
  log?: (message: string) => void, maxRetries = maxOpenSshHostKeyRetries
): Promise<T> {
  let result = await run();
  for (let retry = 1;
    retry <= maxRetries
      && result.exitCode !== 0
      && isOpenSshHostKeyVerificationFailure(result.stderr);
    retry += 1) {
    log?.(`OpenSSH 严格校验遇到尚未记录的负载节点，重新探测并重试（${retry}/${maxRetries}）`);
    await refreshTrust();
    result = await run();
  }
  return result;
}

/**
 * 系统 ssh 路径连接前的主机密钥校验（仅 prompt 模式执行；accept/reject
 * 沿用 platform.ts 的 known_hosts 映射，不做预检）。
 *
 * 决策统一走 host-key.ts 的 verifyHostKeyWithPrompt（与内置 ssh2 通道共用），
 * 首次连接与未分类主机的新密钥会弹窗确认；用户选择追加后，该地址会持久
 * 标记为负载节点，后续新密钥直接自动追加。
 * 确认通过后把探测到的密钥写入扩展独立 known_hosts 文件
 * （setKnownHostsFilePath 注入的路径），由 OpenSSH 原生校验兜底。
 *
 * @param probe   可注入的探测实现（测试用）
 * @param prompts 可注入的弹窗实现（测试用，默认走 host-key 的首次连接弹窗）
 */
export async function verifySystemSshHostKey(
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
    // 系统 SSH 不经过内置 ssh2 的 hostVerifier。若在探测失败后改用
    // StrictHostKeyChecking=no，攻击者只需阻断 ssh-keyscan 就能让后续连接
    // 失去主机身份校验，因此这里必须 fail closed。
    const detail = result.error ?? '未知错误';
    log?.(`主机密钥探测失败（${host.name}）：${detail} — 已中止连接`);
    return {
      ok: false,
      reason: `无法验证主机"${host.name}"的 SSH 主机密钥（${detail}），已中止连接`
    };
  }
  const decision = await verifyHostKeyWithPrompt(host, result.fingerprints, log, prompts);
  if (decision === 'refuse') {
    return {
      ok: false,
      reason: `已拒绝接受主机"${host.name}"的新 SSH 主机密钥（指纹：${result.fingerprints.join(', ')}）`
    };
  }
  const knownHostsFile = getKnownHostsFilePath();
  if (knownHostsFile && result.keys && result.keys.length > 0) {
    try {
      if (decision === 'replace') {
        await replaceKnownHostsForHost(knownHostsFile, host, result.keys, log);
      } else if (decision === 'append') {
        await appendLoadBalancedKnownHostsFile(
          knownHostsFile, host, result.keys, log
        );
      } else if (decision === 'accept') {
        await appendKnownHostsFile(knownHostsFile, result.keys, log);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log?.(`写入主机密钥记录失败（${host.name}）：${detail}`);
      return { ok: false, reason: `无法写入主机密钥记录（${detail}），已中止连接` };
    }
  }
  return { ok: true };
}
