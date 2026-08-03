# Changelog

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
