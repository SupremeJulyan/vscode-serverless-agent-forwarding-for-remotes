# Change Log

## Unreleased

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
