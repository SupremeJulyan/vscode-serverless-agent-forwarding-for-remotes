import type { Prompt } from 'ssh2';

export function keyboardInteractivePasswordReplies(
  prompts: Prompt[], password: string
): string[] | undefined {
  if (prompts.length === 0 || prompts.some((item) => item.echo || !/password/i.test(item.prompt))) {
    return undefined;
  }
  return prompts.map(() => password);
}

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

const networkFailurePatterns = [
  /connection reset by peer/i,
  /connection (?:refused|closed|timed out)/i,
  /connection unexpectedly closed/i,
  /no route to host/i,
  /network is unreachable/i,
  /operation timed out/i,
  /could not connect/i,
  /kex_exchange_identification.*closed/i
];

export function isNetworkFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return networkFailurePatterns.some((pattern) => pattern.test(message));
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
