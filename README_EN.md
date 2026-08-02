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

The native default is `~/serverless-remote-ssh/config.json`; WSL keeps
`~/.wsl-vpn-ssh/config.json` for configuration compatibility.

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
remote roots. A root `AGENTS.override.md` or `AGENTS.md` is returned as workspace
guidance without writing instructions into the local home directory.

## Limitations

- Local command-line programs cannot access `serverless-sftp://` files.
- Extensions that only support `file://` workspaces may be unavailable.
- SFTP has no native change notifications, so external changes are polled.
- WSL configurations with `vpn: true` reuse the Windows TCP relay supplied by
  `wsl-vpn-ssh-bridge`; install the bridge before using that mode. With
  `vpn: false`, SFTP connects directly.
