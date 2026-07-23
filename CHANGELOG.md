# Change Log

## 0.8.3

- Use a fixed 8-second connection timeout and offer `Open Config` when the network
  is unreachable or the saved SSH password may be wrong.
- Encrypt passwords while creating SSH configurations and migrate legacy plaintext passwords on use.
- Resolve wizard-created WSL, Linux, and macOS mount directories below the workspace from which Open Remote Folder is invoked.
- Report SSH password authentication failures, clear the rejected password, and open the configuration with the replacement field selected.

## 0.8.1

- Replace the separate SSHFS setup wizard with an automatically generated mount for each SSH configuration.
- Mount the SSH login directory by default and always open its SSH terminal.
- Default local mounts to `[name]` below the current workspace on WSL, Linux, and macOS, and to `R:` on Windows.
- Reduce Add SSH Config to name, `user@host`, and one password-or-key authentication choice.
- On WSL, add an optional VPN relay step defaulting to `false`; external VPN clients such as aTrust require `true`.
- Remove Mount, rename Unmount to Close, and replace the Windows installer command with cross-platform dependency tips.

## 0.7.15

- Dispose a mount's existing WSL bridge terminal before switching folders so
  VS Code cannot reconnect the renamed `sshpass` PTY alongside a new terminal.

## 0.7.14

- Prevent duplicate WSL SSH terminals when pending-folder recovery and
  workspace auto-connect run at the same time.
- Track remote terminals with a stable identity even when VS Code changes the
  displayed terminal title to the active `sshpass` process.

## 0.7.13

- Open WSL remote terminals in the subdirectory corresponding to the active
  local SSHFS path, without reusing a terminal from a different subdirectory.
- Fall back to lazy Linux unmounting only when a normal unmount reports that
  the mount point is busy.

## 0.7.12

- Pass the VS Code-stored encryption master password to WSL bridge commands and
  time out blocked non-interactive mount processes.
- Start the local SSH client from the user home so macOS can create the remote
  terminal while an SSHFS folder is replacing an empty VS Code workspace.

## 0.7.11

- Keep newly created native SSHFS mounts alive while replacing the current VS Code workspace with the mounted directory.

## 0.7.10

- Change the native Windows, macOS, and Linux default configuration path to `~/serverless-remote-ssh/config.json`; WSL keeps `~/.wsl-vpn-ssh/config.json` for bridge compatibility.

## 0.7.9

- Automatically open the matching remote terminal when VS Code opens a configured mount directory or one of its subdirectories.

## 0.7.8

- Add encrypted-password authentication and plaintext-password migration for native Linux SSHFS mounts and SSH terminals.

## 0.7.7

- Remove the Explorer `R` shortcut; remote terminals are opened explicitly through `Open Remote Terminal`.

## 0.7.6

- Start native Windows, macOS, and Linux SSH terminals in the remote subdirectory corresponding to the current folder inside an SSHFS mount.

## 0.7.5

- Add manual VSIX installation instructions, use Simplified Chinese as the default README, and provide English in `README_EN.md`.
- Automatically unmount Linux and macOS SSHFS mounts created by the current extension session when the VS Code window closes.

## 0.7.4

- Add encrypted-password decryption and automatic password authentication for native macOS SSHFS mounts and SSH terminals.
- Migrate existing plaintext macOS passwords to the bridge-compatible `enc:v1:` format when first used.
- Pass macOS passwords through a short-lived `SSH_ASKPASS` helper without exposing them in command arguments or task output.
- Open the matching SSH terminal directly with `R` from Explorer when the current directory is a configured mount or one of its children, preserving the corresponding remote subdirectory.
- Reuse the matching SSH terminal when it is already open instead of starting a duplicate connection.

## 0.7.3

- Add JSON Schema completion, validation, snippets, and hover help for the shared configuration.

## 0.7.2

- Add a complete, annotated configuration template for first-time setup.

## 0.7.1

- Create a minimal configuration file when Open Config is used for the first time.
- Guide users to Open Config when configuration is missing, unreadable, or empty.
- Close a workspace that is using a mount before unmounting it, then resume the unmount after VS Code reloads.
- Show mount and WSL relay diagnostics in the Output panel instead of opening an SSH terminal.

## 0.7.0

- Fixed WSL and macOS mount-state detection.
- Added Windows custom-private-key forwarding to SSHFS-Win.
- Added expiration and failure cleanup for pending cross-window workflows.
- Added stale FUSE cleanup support to the companion bridge.

## 0.6.0

- Mount and verify the remote directory before opening the local folder.
- Resume only the SSH terminal step after the VS Code window reloads.

## 0.5.0

- Turned Open Remote Folder into a restart-safe integrated workflow: open the local folder, mount it, then connect the remote terminal.
- Prevented WSL now-mode mounts from opening a duplicate bridge terminal.

## 0.4.0

- Open the matching SSH terminal after mounting and opening a remote folder.
- Reuse the resolved mount directory as the terminal working directory.

## 0.3.0

- Added Windows, macOS, Linux, and WSL SSHFS platform adapters.
- Added native SSH terminal command generation and WSL bridge relay delegation.

## 0.2.0

- Updated command integration to `ssh-bridge` and `sshfs-bridge`.

## 0.1.0

- Initial installable extension.
- Open SSHFS-backed remote folders.
- Open matching `ssh-bridge` terminals.
- Mount, unmount, status, and shared-config commands.
