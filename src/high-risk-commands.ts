import * as path from 'node:path';

/**
 * 覆写风险块设备名（/dev 下）：磁盘、分区、映射器、内存设备。
 * 以 \b 收尾避免误匹配 /dev/sdfoobar 之类普通路径；/dev/null、/dev/zero、
 * /dev/urandom、/dev/stdout 等安全目标不在此列。
 */
const deviceOverwritePattern =
  'sd[a-z]\\d*|vd[a-z]\\d*|nvme\\d+[a-z0-9]*|mapper/|disk/|md\\d+[a-z0-9]*|mmcblk\\d+[a-z0-9]*|mem|kmem|port';

export const defaultHighRiskCommandPatterns: string[] = [
  // 磁盘 / 分区 / 文件系统操作
  '(?<![\\w./-])mkfs(?:\\.\\w+)?(?:\\s|$)',
  '(?<![\\w./-])(?:fdisk|sfdisk|parted|wipefs|shred)\\b',
  'dd\\s+(?:(?!\\bof=/dev/(?:null|zero|urandom)\\b).)*\\bof=/dev/(?!\\b(?:null|zero|urandom)\\b)',
  // 关机 / 重启
  '(?<![\\w./-])(?:shutdown|reboot|halt|poweroff)\\b',
  'systemctl\\s+(?:poweroff|reboot|halt)\\b',
  // SysV init 关机 / 重启
  '(?<![\\w./-])(?:init|telinit)\\s+[06]\\b',
  // sysrq 紧急关机
  'echo\\s+o\\s+>\\s*/proc/sysrq-trigger',
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
  'iptables\\s+--flush\\b',
  '(?<![\\w./-])ufw\\s+disable\\b',
  'nft\\s+flush\\s+(?:ruleset|chain|table)',
  'systemctl\\s+(?:stop|disable)\\s+(?:firewalld|ufw|nftables)\\b',
  // 存储 / 卷毁灭
  '(?<![\\w./-])zpool\\s+destroy\\b',
  '(?<![\\w./-])zfs\\s+destroy\\b',
  '(?<![\\w./-])mdadm\\s+--(?:stop|zero-superblock)\\b',
  'cryptsetup\\s+luks(?:Format|Erase)\\b',
  '(?<![\\w./-])(?:pvremove|vgremove|lvremove)\\b',
  '(?<![\\w./-])sgdisk\\s+-Z\\b',
  '(?<![\\w./-])blkdiscard\\b',
  // 解除只读挂载（remount 与 rw 顺序无关）
  'mount\\s+[^|;]*(?:remount\\b[^|;]*rw\\b|rw\\b[^|;]*remount\\b)',
  // 引导 / 固件覆写
  '(?<![\\w./-])grub2?-install\\b',
  '(?<![\\w./-])efibootmgr\\b',
  // 从网络管道执行 shell
  '\\b(?:curl|wget)\\b.*\\|\\s*(?:sudo\\s+)?(?:sh|bash|zsh|dash|fish|python3?|perl)\\b',
  // Windows 磁盘 / 分区操作
  '(?<![\\w./-])diskpart\\b',
  'format\\s+[a-z]:',
  // 提权
  '(?<![\\w./-])sudo\\b',
  '(?<![\\w./-])su\\b',
  '(?<![\\w./-])sudoedit\\b',
  '(?<![\\w./-])(?:doas|pkexec|gksu|gksudo|kdesu|runas)\\b',
  'chmod\\s+(?:[ugoa]*\\+s\\b|[246][0-7]{3}\\b)',
  '\\b(?:setuid|setgid)\\b',
  '(?<![\\w./-])(?:visudo|sudoers)\\b',
  '(?<![\\w./-])(?:passwd|useradd|usermod|userdel|groupadd|groupmod|groupdel)\\b',
  '(?<![\\w./-])chpasswd\\b',
  'gpasswd\\s+-a\\b',
  'adduser\\s+\\S+\\s+(?:sudo|wheel)\\b',
  'usermod\\s+-aG\\s+(?:sudo|wheel)\\b',
  '(?<![\\w./-])net\\s+(?:user|localgroup)\\b',
  'chattr\\s+[-+][^ ]*i\\b',
  // 重定向截断系统文件 / 引导区（> /etc/...、: > /etc/shadow、2>/etc/...、>> /boot/...）
  '(?:^|[|;&\\s]|\\b)(?:\\d*:?\\s*)?>+\\s*/(?:etc|boot)/',
  // 重定向覆写块设备（> /dev/sda、> /dev/mapper/...；/dev/null、/dev/zero 等除外）
  `(?:^|[|;&\\s]|\\b)(?:\\d*:?\\s*)?>+\\s*/dev/(?:${deviceOverwritePattern})\\b`,
  `(?:^|[|;&\\s]|\\b)tee\\b[^|;&]*(?:/etc/|/boot/|/dev/(?:${deviceOverwritePattern})\\b)`,
  `(?:^|[|;&\\s]|\\b)truncate\\b[^|;&]*(?:/etc/|/boot/|/dev/(?:${deviceOverwritePattern})\\b)`,
  // 文件系统一致性/元数据工具（在挂载盘上运行有破坏性）
  '(?<![\\w./-])(?:fsck|e2fsck|tune2fs)\\b'
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

/**
 * 提取命令中的内嵌执行内容：$(...)、反引号、以及 sh -c / bash -lc / eval 等的
 * 引号参数。提取结果递归展开（内嵌内容里可能还有内嵌），供模式匹配与删除分析
 * 对每一层分别执行——堵住 `sh -c 'rm -rf /'`、`$(rm -rf /)` 等间接执行绕过。
 */
function extractEmbeddedCommands(command: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const pending = [command];
  while (pending.length > 0) {
    const text = pending.pop()!;
    const substitution = /\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`/g;
    const wrapper =
      /\b(?:sh|bash|zsh|dash|ksh|fish)\s+(?:-[a-zA-Z0-9]+\s+)*-?[a-zA-Z0-9]*c[a-zA-Z0-9]*\s+("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\beval\s+("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
    for (const match of text.matchAll(substitution)) {
      const inner = match[1] ?? match[2];
      if (inner && !seen.has(inner)) {
        seen.add(inner);
        result.push(inner);
        pending.push(inner);
      }
    }
    for (const match of text.matchAll(wrapper)) {
      const quoted = match[1] ?? match[2];
      if (!quoted) continue;
      const inner = quoted.slice(1, -1);
      if (inner && !seen.has(inner)) {
        seen.add(inner);
        result.push(inner);
        pending.push(inner);
      }
    }
  }
  return result;
}

/** 去掉 shell 转义前缀与命令分隔符残留（\rm、;rm、$(rm → rm） */
function commandName(token: string): string {
  return token.replace(/^[\\;|&$()`]+/, '');
}

/** 解析 rm 命令：收集目标，命中危险目标则返回原因 */
function matchDangerousRm(command: string): string | undefined {
  const tokens = tokenizeCommand(command);
  for (let i = 0; i < tokens.length; i++) {
    if (commandName(tokens[i]) !== 'rm') continue;
    const targets: string[] = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const token = tokens[j];
      if (commandSeparators.has(token) || commandName(token) === 'rm') break;
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
  const index = tokens.findIndex((token) => commandName(token) === 'find');
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

/** chmod / chown 目标分析：模式/属主后的目标路径危险才拦截 */
function matchDangerousChmodChown(command: string): string | undefined {
  const tokens = tokenizeCommand(command);
  for (let i = 0; i < tokens.length; i++) {
    const base = commandName(tokens[i]);
    if (base !== 'chmod' && base !== 'chown') continue;
    const args: string[] = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const token = tokens[j];
      if (commandSeparators.has(token)
        || commandName(token) === 'chmod' || commandName(token) === 'chown') break;
      if (token.startsWith('-') && token !== '--') continue;
      args.push(token);
    }
    // 第一个非标志参数是模式（chmod）或属主（chown），其余是目标路径
    if (args.length < 2) continue;
    const dangerous = args.slice(1).filter(isDangerousDeleteTarget);
    if (dangerous.length > 0) {
      return `${base} 危险目标: ${dangerous.join(' ')}`;
    }
  }
  return undefined;
}

/** 智能删除分析：rm / find / xargs / chmod / chown 的危险操作（含内嵌命令层） */
export function matchHighRiskDelete(command: string): string | undefined {
  for (const candidate of [command, ...extractEmbeddedCommands(command)]) {
    const hit = matchDangerousRm(candidate)
      ?? matchDangerousFind(candidate)
      ?? matchDangerousXargsRm(candidate)
      ?? matchDangerousChmodChown(candidate);
    if (hit) return hit;
  }
  return undefined;
}

export function matchHighRiskCommand(
  command: string,
  patterns: readonly string[] = defaultHighRiskCommandPatterns
): string | undefined {
  // 对原始命令与每一层内嵌执行内容分别做模式匹配（stripQuotedSegments 会剥掉
  // 引号内容，间接执行的内容必须在解包后的候选上重新匹配）。
  for (const candidate of [command, ...extractEmbeddedCommands(command)]) {
    const normalized = stripQuotedSegments(candidate.trim());
    for (const pattern of patterns) {
      try {
        if (new RegExp(pattern, 'i').test(normalized)) return pattern;
      } catch {
        // 忽略无效规则，避免单个配置错误影响所有命令
      }
    }
  }
  return matchHighRiskDelete(command);
}

/**
 * 保守判断 Agent Shell 是否只读。无法证明只读的命令一律返回 false，交由调用方
 * 请求用户确认。这里只放行常见的查看、搜索和 Git 查询命令。
 */
export function isReadOnlyRemoteCommand(command: string): boolean {
  if (!command.trim() || /[\n\r`]|\$\(|<\(|>\(/.test(command)) return false;
  // 除丢弃 stderr/stdout 外，任何重定向都可能创建或覆盖文件。
  const withoutNullRedirects = command.replace(/(?:\d*>>?|&>)\s*\/dev\/null\b/g, '');
  if (/[<>]/.test(withoutNullRedirects)) return false;
  const segments = withoutNullRedirects.split(/&&|\|\||[|;]/).map((part) => part.trim());
  if (segments.some((segment) => !segment)) return false;
  const simpleReadOnly = new Set([
    'pwd', 'ls', 'dir', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg',
    'wc', 'stat', 'file', 'du', 'df', 'uname', 'whoami', 'id', 'realpath',
    'readlink', 'which', 'whereis', 'type', 'printenv', 'uptime',
    'ps', 'free', 'lscpu', 'basename', 'dirname', 'sort', 'uniq',
    'cut', 'tr', 'cmp', 'diff', 'sha256sum', 'md5sum', 'test', '[', 'echo',
    'printf', 'true', 'false'
  ]);
  const gitReadOnly = new Set([
    'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'grep',
    'describe', 'blame', 'shortlog', 'name-rev'
  ]);
  return segments.every((segment) => {
    const tokens = tokenizeCommand(segment);
    while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
    if (tokens[0] === 'command') tokens.shift();
    const executable = commandName(tokens[0] ?? '').split('/').at(-1) ?? '';
    if (simpleReadOnly.has(executable)) {
      if (executable === 'sort' && tokens.some((token) =>
        token === '-o' || token === '--output' || token.startsWith('--output=')
      )) return false;
      return true;
    }
    if (executable === 'find') {
      return !tokens.some((token) =>
        ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls']
          .includes(token)
      );
    }
    if (executable === 'sed') return !tokens.some((token) => /^-.*i/.test(token));
    if (executable === 'git') {
      return gitReadOnly.has(tokens[1] ?? '') && !tokens.some((token) =>
        token === '--output' || token.startsWith('--output=')
      );
    }
    return false;
  });
}
