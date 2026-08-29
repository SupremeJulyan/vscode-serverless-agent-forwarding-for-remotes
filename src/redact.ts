/**
 * 对可能包含敏感信息的文本做脱敏，用于输出通道与 MCP 命令日志：
 * - Bearer 令牌（`Authorization: Bearer sk-...`、`-H "Authorization: Bearer ..."`）
 * - URL 查询参数令牌（`?token=...`、`&api_key=...`）
 * - 认证请求头（Authorization / x-api-key / x-auth-token 的 `: 值` 或 `= 值`）
 * - 常见密钥命令行标志（`--token abc`、`--api-key=abc`、`--secret abc`）
 * - 环境变量式赋值（`export API_KEY=...`、`TOKEN=...`）
 *
 * 目标是把 Agent 通过 run_remote_command 传入的密钥从日志/输出中隐藏，
 * 避免明文落盘；不是完整机密扫描，误伤普通文本中的上述字样可接受。
 */
export function redactSensitiveText(value: string): string {
  return value
    // 认证头（含 Authorization: Bearer <token> 一体处理，避免二次替换）
    .replace(
      /(\b(?:authorization|proxy-authorization|x-api-key|x-auth-token)\b[^\s'",;]*\s*[:=]\s*(?:Bearer\s+)?)[^\s'",;]+/gi,
      '$1<hidden>'
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<hidden>')
    // URI userinfo（postgres://user:password@host、https://user:password@host）。
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/'"@:]+:)[^\s/'"@]+(@)/gi, '$1<hidden>$2')
    .replace(
      /([?&](?:token|key|secret|password|apikey|api_key|signature)=)[^&\s'"\\]+/gi,
      '$1<hidden>'
    )
    // 密钥命令行标志（--token tok、--api-key=abc；标志前是空白或命令分隔符）
    .replace(
      /((?:^|[;&|\s])--?(?:token|api[-_]?key|secret|password|passwd|passphrase)\b\s*=?\s*)(['"])(.*?)\2/gi,
      '$1$2<hidden>$2'
    )
    .replace(
      /((?:^|[;&|\s])--?(?:token|api[-_]?key|secret|password|passwd|passphrase)\b\s*=?\s*)[^\s'",;]+/gi,
      '$1<hidden>'
    )
    .replace(
      /(\b(?:api[_-]?key|secret|token|passwd|password|passphrase)\s*=\s*)(['"])(.*?)\2/gi,
      '$1$2<hidden>$2'
    )
    .replace(
      /(\b(?:api[_-]?key|secret|token|passwd|password|passphrase)\s*=\s*)[^\s'",;&|]+/gi,
      '$1<hidden>'
    )
    // curl/basic-auth 风格的显式用户凭据。
    .replace(/((?:^|\s)(?:curl\s+)?(?:-u|--user)\s+)(['"])(.*?)\2/gi, '$1$2<hidden>$2')
    .replace(/((?:^|\s)(?:curl\s+)?(?:-u|--user)\s+)[^\s'";|]+/gi, '$1<hidden>');
}
