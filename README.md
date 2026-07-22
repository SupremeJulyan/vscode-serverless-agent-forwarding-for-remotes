# Serverless Remote SSH

Edit remote files in VS Code through SSHFS and use a real SSH terminal without installing VS Code Server on the target host.

The extension selects a platform adapter and exposes every remote folder as a real operating-system mount. WSL delegates VPN relay lifecycle to `sshfs-bridge` and `ssh-bridge`; native Windows, macOS, and Linux connect through the VPN/network stack of that operating system.

## Requirements

- Windows: WinFsp and SSHFS-Win; `local_path` must be a drive letter such as `X:`
- macOS: macFUSE SSHFS plus OpenSSH
- Linux: SSHFS, FUSE 3, and OpenSSH
- WSL: `ssh-bridge`, `sshfs-bridge`, and `mountpoint`
- Unified configuration at `~/.wsl-vpn-ssh/config.json`

Example:

```json
{
  "encrypt_passwords": true,
  "hosts": [
    {
      "name": "dev",
      "ip": "10.0.0.2",
      "user": "alice",
      "port": 22,
      "vpn": true
    }
  ],
  "mounts": [
    {
      "name": "project",
      "host": "dev",
      "remote_path": "/home/alice/project",
      "local_path": "/home/alice/mnt/project",
      "local_paths": {
        "windows": "X:",
        "macos": "/Users/alice/mnt/project",
        "linux": "/home/alice/mnt/project",
        "wsl": "/home/alice/mnt/project"
      },
      "remote_terminal": "open"
    }
  ]
}
```

## Commands

- `Serverless Remote SSH: Open Remote Folder` mounts the selected entry, opens its local SSHFS directory, and opens a remote terminal in that folder.
- `Serverless Remote SSH: Open Remote Terminal` starts `ssh-bridge` in an integrated terminal.
- `Serverless Remote SSH: Mount` and `Unmount` manage a selected SSHFS entry.
- `Serverless Remote SSH: Show Status` opens an output panel summarizing every mount and, on WSL, the SSHFS/SSH relay state.
- `Serverless Remote SSH: Open Config` opens the shared JSON configuration.

For a `now` mount, the extension asks which local directory should receive the mount. For other modes, `local_paths` selects a path for the current platform and falls back to `local_path`. On Windows, configure a drive letter instead of a POSIX path.

`vpn: true` means “use the VPN-visible network path.” On WSL the bridge starts and shares the Windows TCP relay. On native Windows, macOS, and Linux no extra relay is needed because SSHFS runs in the same network namespace as that platform's VPN client.

## Install

```bash
code --install-extension vscode-serverless-remote-ssh-0.7.0.vsix
```

After installation, use the `$(remote) Serverless SSH` status bar item or open the Command Palette.

## Development

```bash
npm install
npm test
npm run package
npm run vsix
```

This extension keeps language services and extensions local. Commands that must execute on the target should be run through the SSH terminal.
