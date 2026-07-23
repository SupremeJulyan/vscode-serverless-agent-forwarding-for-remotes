const authenticationFailurePatterns = [
  /permission denied/i,
  /authentication (?:failed|failure)/i,
  /access is denied/i,
  /logon failure/i,
  /user name or password is incorrect/i,
  /incorrect password/i,
  /密码错误/,
  /认证失败/
];

export function isAuthenticationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return authenticationFailurePatterns.some((pattern) => pattern.test(message));
}

export function passwordValueOffset(content: string, hostName: string): number | undefined {
  const escapedName = JSON.stringify(hostName);
  const namePattern = new RegExp(`"name"\\s*:\\s*${escapedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const nameMatch = namePattern.exec(content);
  if (!nameMatch) return undefined;
  const remainder = content.slice(nameMatch.index + nameMatch[0].length);
  const passwordMatch = /"password"\s*:\s*"/.exec(remainder);
  if (!passwordMatch) return undefined;
  return nameMatch.index + nameMatch[0].length + passwordMatch.index + passwordMatch[0].length;
}
