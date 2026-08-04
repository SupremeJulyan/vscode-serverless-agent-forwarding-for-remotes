export const defaultHighRiskCommandPatterns: string[] = [
  // 递归强制删除
  'rm\\s+-(?:[a-z]*rf[a-z]*|[a-z]*fr[a-z]*)\\b',
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
  return undefined;
}
