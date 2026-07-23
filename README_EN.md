# Serverless Remote SSH

[简体中文](README.md) | [English](README_EN.md)

Edit remote files in VS Code through SSHFS and use a real SSH terminal without installing VS Code Server on the target host.

The extension selects a platform adapter and exposes every remote folder as a real operating-system mount. WSL delegates VPN relay lifecycle to `sshfs-bridge` and `ssh-bridge`; native Windows, macOS, and Linux connect through the VPN/network stack of that operating system.

## Requirements

- Windows: WinFsp and SSHFS-Win; `local_path` must be a drive letter such as `X:`
- macOS: macFUSE SSHFS plus OpenSSH
- Linux: SSHFS, FUSE 3, and OpenSSH
- WSL: `ssh-bridge`, `sshfs-bridge`, and `mountpoint`
- Unified configuration at `~/.wsl-vpn-ssh/config.json`

On Windows, if WinFsp or SSHFS-Win is missing, the extension asks for confirmation before downloading the pinned official MSI installers, verifies their SHA-256 checksums, and starts the administrator installation.
Declining the prompt is remembered for that installer version; use `Serverless Remote SSH: Install Windows Dependencies` to retry manually.
On macOS, a missing dependency prompt links to the official macFUSE SSHFS installation instructions.
On Linux and WSL, the extension reads `/etc/os-release` and offers a copyable install command for Debian/Ubuntu,
Fedora/RHEL, Arch/Manjaro, openSUSE, or Alpine. When the WSL bridge commands are missing, the command also
installs the bridge from its official GitHub repository.

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
- `Serverless Remote SSH: Open Remote Terminal` opens an SSH connection in an integrated terminal and uses `ssh-bridge` on WSL. When the workspace or active file is inside a configured mount, the extension selects the matching configuration and enters the corresponding remote subdirectory on WSL and native Windows, macOS, or Linux.
- `Serverless Remote SSH: Mount` and `Unmount` manage a selected SSHFS entry.
- `Serverless Remote SSH: Show Status` opens an output panel summarizing every mount and, on WSL, the SSHFS/SSH relay state.
- `Serverless Remote SSH: Open Config` opens the shared JSON configuration.
- `Serverless Remote SSH: Add SSH Config` prompts for each SSH host field and saves it to the shared configuration.
- `Serverless Remote SSH: Add SSHFS Config` prompts for each mount field, including the referenced SSH host and terminal mode.

Passwords entered through `Add SSH Config` are encrypted in the bridge-compatible `enc:v1:` format before the configuration is written. The encryption master password is kept in VS Code SecretStorage. On Windows and macOS, an existing plaintext password is migrated automatically the next time it is used. macOS supplies the decrypted password to OpenSSH and SSHFS through a short-lived `SSH_ASKPASS` helper; the password is never added to command arguments or task output.

For a `now` mount, the extension asks which local directory should receive the mount. For other modes, `local_paths` selects a path for the current platform and falls back to `local_path`. On Windows, configure a drive letter instead of a POSIX path.

`vpn: true` means “use the VPN-visible network path.” On WSL the bridge starts and shares the Windows TCP relay. On native Windows, macOS, and Linux no extra relay is needed because SSHFS runs in the same network namespace as that platform's VPN client.
The macOS and Linux configuration wizard hides the relay option, and their status output does not include a relay section.

On Linux and macOS, mounts created by the current VS Code extension session are automatically unmounted when that VS Code window closes. Mounts that already existed before the session are left untouched.

## Install

### Install manually in VS Code

1. Download the `.vsix` package to your computer.
2. Open VS Code and select the **Extensions** icon in the Activity Bar, or press `Ctrl+Shift+X` (`Cmd+Shift+X` on macOS).
3. Select the **Views and More Actions...** (`...`) menu in the upper-right corner of the Extensions view.
4. Select **Install from VSIX...**.
5. Choose `vscode-serverless-remote-ssh-0.7.7.vsix` and confirm the installation.
6. Select **Reload Now** if VS Code asks you to reload the window.
7. Use the `$(remote) Serverless SSH` status bar item or open the Command Palette and run a `Serverless Remote SSH` command.

To upgrade an existing installation, repeat these steps with the newer VSIX package. VS Code replaces the installed version.

### Install from the command line

```bash
code --install-extension vscode-serverless-remote-ssh-0.7.7.vsix
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
