import * as path from 'node:path';

export const defaultHighRiskCommandPatterns: string[] = [
  // 磁盘 / 分区 / 文件系统操作
  '(?<![\\w./-])mkfs(?:\\.\\w+)?(?:\\s|$)',
  '(?<![\\w./-])(?:fdisk|sfdisk|parted|wipefs|shred)\\b',
  'dd\\s+(?:(?!of=/dev/null\\b).)*\\bof=/dev/',
  // 关机 / 重启
  '(?<![\\w./-])(?:shutdown|reboot|halt|poweroff)\\b',
  'systemctl\\s+(?:poweroff|reboot|halt)\\b',
  // SysV init 关机 / 重启
  '(?<![\\w./-])(?:init|telinit)\\s+[06]\\b',
  // 根目录权限变更
  'chmod\\s+-R\\s+777\\s+/',
  'chmod\\s+-R\\s+000\\s+/',
  'chmod\\s+-R\\s+(?:a-x|a-w|a-r)\\s+/',
  'chown\\s+-R\\s+(?:root|0)\\s+/',
  // 杀死系统初始化进程
  'kill\\s+-(?:9|KILL)\\s+1(?:\\s|$)',
  '(?<![\\w./-])pkill\\s+-(?:9|KILL)\\s+init\\b',
  // fork bomb
  ':\\(\\)\\{\\s*:\\|:&\\s*\\}\\s*;',
  // 内核参数写入
  'sysctl\\s+-w\\b',
  '(?:echo|printf)\\s+[^>|;]*>[^\\n]*/proc/sys/',
  // 防火墙清空 / 禁用
  '(?<![\\w./-])iptables\\s+-(?:F|X)\\b',
  '(?<![\\w./-])ufw\\s+disable\\b',
  'nft\\s+flush\\s+(?:ruleset|chain|table)',
  // 存储 / 卷毁灭
  '(?<![\\w./-])zpool\\s+destroy\\b',
  '(?<![\\w./-])mdadm\\s+--(?:stop|zero-superblock)\\b',
  'cryptsetup\\s+luks(?:Format|Erase)\\b',
  '(?<![\\w./-])(?:pvremove|vgremove|lvremove)\\b',
  // 解除只读挂载
  'mount\\s+[^|;]*remount\\s*,?\\s*rw\\b',
  // 引导 / 固件覆写
  '(?<![\\w./-])grub-install\\b',
  '(?<![\\w./-])efibootmgr\\b',
  // 从网络管道执行 shell
  '\\b(?:curl|wget)\\b.*\\|\\s*(?:sudo\\s+)?(?:sh|bash|zsh)\\b',
  // Windows 磁盘 / 分区操作
  '(?<![\\w./-])diskpart\\b',
  'format\\s+[a-z]:',
  // 提权
  '(?<![\\w./-])sudo\\b',
  '(?<![\\w./-])su\\b',
  '(?<![\\w./-])(?:doas|pkexec|gksu|gksudo|kdesu|runas)\\b',
  'chmod\\s+(?:[ugoa]*\\+s\\b|[246][0-7]{3}\\b)',
  '\\b(?:setuid|setgid)\\b',
  '(?<![\\w./-])(?:visudo|sudoers)\\b',
  '(?<![\\w./-])(?:passwd|useradd|usermod|userdel|groupadd|groupmod|groupdel)\\b',
  '(?<![\\w./-])net\\s+(?:user|localgroup)\\b',
  'chattr\\s+[-+][^ ]*i\\b'
];

function stripQuotedSegments(command: string): string {
  return command.replace(/(['"])(?:\\.|(?!\1).)*\1/g, ' ');
}

// ─── 智能删除目标分析 ───────────────────────────────────────────────────────
// 不再对 rm -rf / find -delete 一刀切：只拦截删除目标是系统关键位置、
// 家目录、通配符或范围不确定的操作；`rm -rf ./dist`、`find ./src -delete`
// 等指向具体安全目录的常见清理操作直接放行。

/** 系统核心目录：本身或任意子目录都不可删除 */
const systemDeleteRoots = [
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/var', '/root'
];

/** 挂载点本身不可删，其下的具体子目录可删（如 /home/user/project） */
const mountDeleteRoots = ['/home', '/opt', '/srv', '/mnt', '/media'];

const commandSeparators = new Set([';', '|', '||', '&&', '&']);

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"']+)/g;
  for (const match of command.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined && value.length > 0) tokens.push(value);
  }
  return tokens;
}

/** 判断单个删除目标是否危险 */
export function isDangerousDeleteTarget(token: string): boolean {
  if (!token) return false;
  // 家目录 / 环境变量展开：~、~/x、$HOME、${VAR} 均无法静态确认范围
  if (token.startsWith('~') || token.includes('$')) return true;
  // 通配符：范围不确定，可能命中系统内容
  if (/[*?[]/.test(token)) return true;
  const normalized = path.posix.normalize(token);
  // 根目录本身、当前目录内容、父目录（含 ../ 序列）
  if (normalized === '/' || normalized === '.' || normalized === '..'
    || normalized.startsWith('../')) return true;
  for (const root of systemDeleteRoots) {
    if (normalized === root || normalized.startsWith(`${root}/`)) return true;
  }
  for (const root of mountDeleteRoots) {
    if (normalized === root) return true;
  }
  return false;
}

/** 解析 rm 命令：收集目标，命中危险目标则返回原因 */
function matchDangerousRm(command: string): string | undefined {
  const tokens = tokenizeCommand(command);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'rm') continue;
    const targets: string[] = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const token = tokens[j];
      if (commandSeparators.has(token) || token === 'rm') break;
      if (token.startsWith('-') && token !== '--') continue;
      targets.push(token);
    }
    const dangerous = targets.filter(isDangerousDeleteTarget);
    if (dangerous.length > 0) {
      return `rm 删除危险目标: ${dangerous.join(' ')}`;
    }
  }
  return undefined;
}

/** find 带删除动作（-delete / -exec rm）且起始路径危险（含缺省当前目录） */
function matchDangerousFind(command: string): string | undefined {
  if (!/\bfind\b/.test(command)) return undefined;
  if (!/\s(?:-delete|-exec\s+rm\b|-execdir\s+rm\b|-ok\s+rm\b)/.test(command)) {
    return undefined;
  }
  const tokens = tokenizeCommand(command);
  const index = tokens.findIndex((token) => token === 'find');
  if (index < 0) return undefined;
  const paths: string[] = [];
  for (let j = index + 1; j < tokens.length; j++) {
    const token = tokens[j];
    if (commandSeparators.has(token) || token.startsWith('-')) break;
    paths.push(token);
  }
  if (paths.length === 0 || paths.some(isDangerousDeleteTarget)) {
    return 'find 删除操作路径危险';
  }
  return undefined;
}

/** xargs rm：目标由上游动态传入，无法静态判断，保守拦截 */
function matchDangerousXargsRm(command: string): string | undefined {
  if (/\bxargs\s+(?:-[^\s]+\s+)*rm\b/.test(command)) {
    return 'xargs rm 动态删除';
  }
  return undefined;
}

/** 智能删除分析：rm / find / xargs 的危险删除行为 */
export function matchHighRiskDelete(command: string): string | undefined {
  return matchDangerousRm(command)
    ?? matchDangerousFind(command)
    ?? matchDangerousXargsRm(command);
}

export function matchHighRiskCommand(
  command: string,
  patterns: readonly string[] = defaultHighRiskCommandPatterns
): string | undefined {
  const normalized = stripQuotedSegments(command.trim());
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, 'i').test(normalized)) return pattern;
    } catch {
      // 忽略无效规则，避免单个配置错误影响所有命令
    }
  }
  return matchHighRiskDelete(command);
}
