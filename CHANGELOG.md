# Change Log

## Unreleased

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
