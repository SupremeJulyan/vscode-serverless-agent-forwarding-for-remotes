export interface AgentMcpSetupResult {
  succeeded: boolean;
  registeredAgents: string[];
}

export function agentForwardingInstallMessage(
  registeredAgents: readonly string[], succeeded: boolean
): string | undefined {
  const names = [...new Set(registeredAgents.map((name) => name.trim()).filter(Boolean))];
  if (names.length === 0) return undefined;
  return `${names.join('、')} 转发安装成功。${
    succeeded ? '' : '其他 Agent 未能自动配置，请查看 SAFS 日志。'
  }`;
}
