# Serverless Remote SSH

[简体中文](README.md) | [English](README_EN.md)

Edit remote files in VS Code through SSHFS and use a real SSH terminal without installing VS Code Server on the target host.

The extension selects a platform adapter and exposes every remote folder as a real operating-system mount. WSL delegates VPN relay lifecycle to `sshfs-bridge` and `ssh-bridge`; native Windows, macOS, and Linux connect through the VPN/network stack of that operating system.

## Requirements

- Windows: WinFsp and SSHFS-Win; the default mount is drive `R:`
- macOS: macFUSE SSHFS plus OpenSSH
- Linux: SSHFS, FUSE 3, and OpenSSH
- WSL: `ssh-bridge`, `sshfs-bridge`, and `mountpoint`
- Native Windows, macOS, and Linux default to `~/serverless-remote-ssh/config.json`
- WSL keeps `~/.wsl-vpn-ssh/config.json` shared with `ssh-bridge` and `sshfs-bridge`

Windows requires OpenSSH Client, WinFsp, and SSHFS-Win. Run `Serverless Remote SSH: Install Dependencies Tips` to check missing software and display installation guidance.
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
      "name": "dev",
      "host": "dev",
      "remote_path": ".",
      "local_path": "/current/directory/dev",
      "remote_terminal": "open"
    }
  ]
}
```

## Commands

- `Serverless Remote SSH: Open Remote Folder` mounts the selected entry, opens its local SSHFS directory, and opens a remote terminal in that folder.
- `Serverless Remote SSH: Open Remote Terminal` opens an SSH connection in an integrated terminal and uses `ssh-bridge` on WSL. When the workspace or active file is inside a configured mount, the extension selects the matching configuration and enters the corresponding remote subdirectory on WSL and native Windows, macOS, or Linux.
- `Serverless Remote SSH: Close` closes the remote folder and unmounts its SSHFS entry.
- `Serverless Remote SSH: Show Status` opens an output panel summarizing every mount and, on WSL, the SSHFS/SSH relay state.
- `Serverless Remote SSH: Open Config` opens the shared JSON configuration.
- `Serverless Remote SSH: Add SSH Config` asks for a name, `user@host`, and a password. After a password is entered, it also asks you to set and confirm a configuration encryption passphrase. Leaving the password empty asks for a private-key path instead, so only one authentication method is saved. WSL adds a VPN relay prompt which defaults to `false`; select `true` when using an external VPN such as aTrust.
- `Serverless Remote SSH: Install Dependencies Tips` checks required software and shows missing packages or a copyable installation command.

New configurations always mount the SSH login directory and use the `open` terminal behavior. WSL, Linux, and macOS create `[configuration name]` below the current workspace by default; Windows uses `R:`. `Open Remote Folder` mounts first, switches to the mounted directory, then creates exactly one SSH terminal after the new window resumes. An existing matching terminal is reused.

SSH passwords entered by the wizard are stored as `enc:v1:` ciphertext using the configuration encryption passphrase. Plaintext passwords in older configurations are migrated the next time they are used. macOS and Linux pass the decrypted password to OpenSSH and SSHFS through a short-lived `SSH_ASKPASS` helper, never through command arguments or task output.

Custom `remote_path`, `local_path`, and `local_paths` values in existing configurations remain supported. Legacy `now` and `never` terminal modes are normalized to `open`.

`vpn: true` means “use the VPN-visible network path.” On WSL the bridge starts and shares the Windows TCP relay. On native Windows, macOS, and Linux no extra relay is needed because SSHFS runs in the same network namespace as that platform's VPN client.
The macOS and Linux configuration wizard hides the relay option, and their status output does not include a relay section.

On Linux and macOS, mounts created by the current VS Code extension session are automatically unmounted when that VS Code window closes. Mounts that already existed before the session are left untouched.

## Install

### Install manually in VS Code

1. Download the `.vsix` package to your computer.
2. Open VS Code and select the **Extensions** icon in the Activity Bar, or press `Ctrl+Shift+X` (`Cmd+Shift+X` on macOS).
3. Select the **Views and More Actions...** (`...`) menu in the upper-right corner of the Extensions view.
4. Select **Install from VSIX...**.
5. Choose `vscode-serverless-remote-ssh-0.8.1.vsix` and confirm the installation.
6. Select **Reload Now** if VS Code asks you to reload the window.
7. Use the `$(remote) Serverless SSH` status bar item or open the Command Palette and run a `Serverless Remote SSH` command.

To upgrade an existing installation, repeat these steps with the newer VSIX package. VS Code replaces the installed version.

### Install from the command line

```bash
code --install-extension vscode-serverless-remote-ssh-0.8.1.vsix
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
