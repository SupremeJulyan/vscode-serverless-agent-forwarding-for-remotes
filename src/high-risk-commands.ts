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
  // 根目录权限变更
  'chmod\\s+-R\\s+777\\s+/',
  'chown\\s+-R\\s+(?:root|0)\\s+/',
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
