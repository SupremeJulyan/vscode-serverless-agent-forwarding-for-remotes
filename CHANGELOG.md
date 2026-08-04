# Changelog

## 1.0.8

- `safs.agentForwardingAgents` now uses real Agent CLI names (`codex`, `claude`; the old `claudeCode` value is still accepted for compatibility) and accepts any CLI name instead of a fixed enum.
- Generic Agent support: the extension detects each configured Agent CLI, probes its `mcp` subcommand, and registers the unified `safs` MCP router automatically when supported. CLIs without an `mcp` subcommand (e.g. `pi`) are skipped and reported in the output panel with a warning notification.

## 1.0.7

- Record every remote command executed through Agent MCP (and SAFS commands such as remote search and the command palette) as an append-only line under `~/.safs/mcp_logs/`, one per-day file.
- Intercept high-risk commands requested by Agents (destructive disk/delete operations and privilege escalation such as `sudo`/`su`/`setuid`), configurable via `safs.highRiskCommandPatterns`; default action denies them, `safs.highRiskCommandAction` can switch to per-command confirmation.

## 1.0.6

- Preserve existing remote file permissions when SFTP saves replace a file, while still saving content when the server does not support `chmod`.

## 1.0.5

- Remember the last switched directory for each remote configuration and restore both the workspace and terminal there when it is reopened.

## 1.0.4

- Add SFTP-backed path completion when switching the current remote directory.
- Move verbose Agent diagnostics to a dedicated log channel, reduce command-output noise, and clear logs periodically.
- Update the repository URL.

## 1.0.3

- Show a reconnect action when a SAFS remote terminal exits, including built-in SSH terminals, and reopen it at the same remote directory.

## 1.0.2

- Enable OpenSSH connection reuse for interactive terminals on every platform, with automatic fallback to a direct connection when reuse is unavailable.

## 1.0.1

- Add a command for switching to a remote subdirectory in the current SAFS window.
- Use readable, filesystem-safe mount names for Agent cwd placeholders.
- Preserve the switched remote directory when opening or restoring SSH terminals.
- Add empty MCP resource and resource-template responses for Codex compatibility.

## 1.0.0

- Initial SAFS release: **Serverless Agent Forwarding for SSH**.
- Browse and edit remote folders through `safs://` SFTP virtual workspaces.
- Open SSH terminals and execute Agent commands in the matching remote directory.
- Forward Codex and Claude Code through the token-protected `safs` MCP router.
- Support native Windows, macOS, Linux, and WSL execution without VS Code Server.
- Store configuration and Agent discovery state under `~/.safs`.
