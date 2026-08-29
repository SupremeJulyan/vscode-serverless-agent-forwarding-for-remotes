import { defaultHighRiskCommandPatterns, matchHighRiskCommand } from './high-risk-commands';
import { redactSensitiveText } from './redact';

export interface McpCommandPolicySettings {
  patterns: readonly string[];
  action: 'deny' | 'allow';
}

export interface ConfigurationReader {
  get<T>(section: string, defaultValue: T): T;
}

export interface McpCommandPolicyDecision {
  allowed: boolean;
  auditSource: string;
  redactedCommand: string;
  matched?: string;
}

export function readMcpCommandPolicySettings(
  configuration: ConfigurationReader
): McpCommandPolicySettings {
  const configuredAction = configuration.get<string>('highRiskCommandAction', 'deny');
  return {
    patterns: configuration.get<string[]>(
      'highRiskCommandPatterns', defaultHighRiskCommandPatterns
    ),
    // 旧版的 confirm 配置不再弹窗，按安全默认值 deny 处理。
    action: configuredAction === 'allow' ? 'allow' : 'deny'
  };
}

/** Evaluate one remote command without executing it or persisting its contents. */
export function evaluateMcpCommandPolicy(
  command: string,
  source: string,
  policy: McpCommandPolicySettings
): McpCommandPolicyDecision {
  const redactedCommand = redactSensitiveText(command);
  if (source !== 'mcp') {
    return { allowed: true, auditSource: source, redactedCommand };
  }
  const matched = matchHighRiskCommand(command, policy.patterns);
  if (!matched) {
    return { allowed: true, auditSource: source, redactedCommand };
  }
  const allowed = policy.action === 'allow';
  return {
    allowed,
    auditSource: allowed ? 'high_risk_allowed' : 'high_risk_denied',
    redactedCommand,
    matched
  };
}
