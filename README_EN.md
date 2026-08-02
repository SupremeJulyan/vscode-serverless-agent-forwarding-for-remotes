# Serverless Remote SSH

[简体中文](README.md) | [English](README_EN.md)

Browse and edit remote files directly in VS Code over SFTP and open real SSH
terminals without installing VS Code Server, SSHFS, FUSE, or WinFsp.

## Features

- Opens remote folders as `serverless-sftp://` virtual workspaces.
- Browse, read, save, create, rename, and delete remote files and directories.
- Password and private-key authentication with optional master-password encryption.
- Pooled SFTP connections, metadata caching, reconnect support, and file polling.
- Opens SSH terminals in the directory selected in the remote workspace.
- Direct remote list/read/write/search tools for VS Code agents and MCP clients.
- Runs builds, tests, Git, and system commands remotely over SSH.

## Quick start

1. Install `vscode-serverless-remote-ssh-1.0.0.vsix`.
2. Run `Serverless Remote SSH: Add SSH Config`.
3. Enter a name, `user@host`, and password or private key.
4. Run `Serverless Remote SSH: Open Remote Folder`.
5. Edit files directly in the Explorer.
6. Run `Serverless Remote SSH: Disconnect` when finished.

```sh
code --install-extension vscode-serverless-remote-ssh-1.0.0.vsix
```

## Configuration

The new default on every platform is `~/.serverless-remote-ssh/config.json`. The legacy
`~/serverless-remote-ssh/config.json` path and WSL's `~/.wsl-vpn-ssh/config.json` remain supported,
so existing configurations do not need to be migrated.

```json
{
  "encrypt_passwords": true,
  "hosts": [{
    "name": "dev",
    "ip": "10.0.0.2",
    "user": "alice",
    "port": 22,
    "private_key_path": "~/.ssh/id_ed25519"
  }],
  "mounts": [{
    "name": "project",
    "host": "dev",
    "remote_path": "/srv/project",
    "remote_terminal": "open"
  }]
}
```

The `mounts` array name remains for backward compatibility. Version 1.0.0
ignores legacy `local_path` and `local_paths` fields because no local mount is
created.

## Agent access

VS Code tools: `#serverlessRemoteList`, `#serverlessRemoteRead`,
`#serverlessRemoteWrite`, `#serverlessRemoteSearch`, and
`#serverlessRemoteRun`.

The loopback-only, token-protected MCP service exposes
`resolve_workspace_execution`, `list_remote_folders`, `remote_list`, `remote_read`, `remote_write`,
`remote_search`, and `run_remote_command`.

Agents call `resolve_workspace_execution` at conversation start to recognize the
active SFTP virtual workspace. Once forwarding is enabled, tools may omit
`mountName` and bind to the active workspace automatically. Remote URIs are not
local paths: agents use SFTP tools for files and SSH execution for builds, tests,
Git, and operating-system inspection. Tools are restricted to forwarding-enabled
remote roots. Agent routing and tool guidance are managed by the fixed MCP service; the
extension does not create or read Agent guidance files on the remote host.

### Unified Agent MCP (Codex / Claude Code)

Each Agent-forwarded remote VS Code window starts an MCP server on an independent
dynamically allocated port. The extension registers the same stable stdio MCP router
for Codex and Claude Code. The router resolves the target window's latest port on every
call. Calls without `mountName`
use the focused, most recently updated window; an explicit `mountName` selects that active
mount. Each window service remains restricted to its own mount.

Window discovery, target selection, dynamic-port routing, disconnect detection,
mount validation, and remote-tool guidance all live in `resources/agent-mcp`. The
integration does not install a Codex plugin, skill, or hooks. MCP instructions tell agents to use only
remote tools for `serverless-sftp` workspaces; because MCP cannot intercept a client's
own local tools, enforcement depends on the agent following those instructions.

Enable Agent Forwarding first installs or updates the fixed `serverless-remote` stdio MCP
for detected Codex and Claude Code installations. If that remote folder is already open,
the action also starts its window-scoped dynamic-port MCP service immediately. Disabling
a mount stops its window service; the extension runs `mcp remove` only after the last
enabled mount is disabled. Restart the Agent and start a new conversation after installing,
updating, or removing MCP.

For local development, you can also install it manually with:

```sh
codex mcp add serverless-remote -- node /path/to/vscode-serverless-remote-ssh/resources/agent-mcp/mcp-router.cjs
claude mcp add --scope user serverless-remote -- node /path/to/vscode-serverless-remote-ssh/resources/agent-mcp/mcp-router.cjs
```

Restart Codex and start a new conversation. Native Windows Codex reads window discovery records from
`%USERPROFILE%`; WSL mode checks both the WSL home and the Windows user profile.
The VS Code extension must remain running with Agent forwarding enabled for the
mount. Disconnecting SFTP preserves that preference, and MCP discovers the new port after
the mount reconnects. If multiple remote windows are open, calls without `mountName` use
the focused, most recently updated window. Keep `serverlessRemote.agentMcpPort` at its
default value of `0`; configuring a fixed port reintroduces multi-window port
collisions.

## Limitations

- Local command-line programs cannot access `serverless-sftp://` files.
- Extensions that only support `file://` workspaces may be unavailable.
- SFTP has no native change notifications, so external changes are polled.
- WSL configurations with `vpn: true` reuse the Windows TCP relay supplied by
  `wsl-vpn-ssh-bridge`; install the bridge before using that mode. With
  `vpn: false`, SFTP connects directly.

## Settings

- `serverlessRemote.agentForwardingAgents`: selects Agents enabled for MCP forwarding;
  defaults to `codex` and `claudeCode`. The extension first searches `PATH` for a CLI
  with MCP commands, then falls back to the corresponding installed VS Code Agent
  extension's bundled CLI.
