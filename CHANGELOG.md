# Change Log

## 2.0.0

- **重启版本**：SFTP 直连架构稳定，版本号重置为 2.0.0。
- WSL 下 `ssh-bridge` 及其 VPN 中继脚本打包进扩展，不再需要单独安装第三方项目。
- 扩展在 WSL 首次激活时自动检查并安装 `ssh-bridge` 所需的 OpenSSH、Python 和 `flock` 系统包。
- WSL 与原生 Linux 统一使用临时 `SSH_ASKPASS` 凭据，不再安装或调用第三方 `sshpass`。
- Windows VPN TCP 中继改为 PowerShell/.NET 实现，不再要求 Windows 主机安装 Python。
- SSH 远程终端对齐 main 分支：终端身份追踪、`Ssh2Terminal`（Windows 密码）、凭据管理、退出的终端提示重新打开。
- AI Agent 转发适配纯 SFTP 工作区：MCP 自动识别当前虚拟远程目录、强制远程工具路由，并通过 SFTP 加载远端 AGENTS.md，不再修改本机用户目录。
- 扩展严格作为 workspace 扩展运行，确保在 Remote-WSL 窗口中安装并运行于 WSL 扩展宿主，而不是 Windows UI 扩展宿主。
- 恢复 `authentication.ts`、`ssh2-terminal.ts`、`ssh-command.ts`、`agent-guidance.ts`。
- Windows ASKPASS 支持恢复。
- 全平台 `exec` 方法统一支持连接复用参数。
- 44 项测试全部通过。

## 1.0.6

- 恢复打开或重载 SFTP 远程工作区时自动创建匹配的 SSH 终端。
- 自动终端使用当前远程工作区目录作为 SSH 登录后的工作目录，避免 VS Code 将虚拟路径误作本地终端 cwd。

## 1.0.5

- 修复跨 Windows、WSL、macOS 和 Linux 环境打开 SSH 终端时，本地启动目录无效的问题。

## 1.0.4

- 恢复 Linux 和 macOS SSH 终端的 ASKPASS 密码认证。
- 恢复 WSL `ssh-bridge` 的加密主口令传递。
- 增加终端密码认证和凭据清理测试。

## 1.0.0

- 用基于 `ssh2` 的 SFTP 虚拟文件系统替代 SSHFS、FUSE、WinFsp 和本地挂载。
- 通过 `serverless-sftp://` 工作区浏览、读取、保存、新建、重命名和删除远程文件。
- 增加 SFTP 连接池、元数据缓存、轮询监听、路径范围保护和临时文件原子保存。
- 将侧栏和状态命令由“挂载/卸载”改为“连接/断开”。
- 保留 SSH 集成终端，并从远程 URI 直接确定远程工作目录。
- Agent 改为通过 SFTP 工具直接列出、读取、写入和搜索远程文件，不再读取本地挂载。
- 移除 SSHFS 依赖安装、挂载恢复、卸载和本地路径配置逻辑。

## 0.9.8

- 删除配置前同时确认挂载点已经断开且本地目录完全为空。
- 删除配置时保留本地目录，由用户手动删除。
- 更新目录非空或仍被挂载时的操作提示。

## 0.9.7

- 在远程文件夹右键菜单中增加删除配置功能。
- 仅在挂载目录完全为空时删除目录和对应配置，目录非空时提示先断开连接。
- 删除挂载后自动清理不再被其他挂载引用的主机配置。

## 0.9.6

- 挂载配置统一写入唯一的 `local_path`，不再按平台分别保存。
- 选择其他本地目录时自动追加挂载名称。
- 拒绝在已有挂载目录中创建嵌套挂载，并继续提示选择其他目录。

## 0.9.5

- Remove automatic dependency detection and show the platform installation
  guide only once, on the extension's first installation.

## 0.9.4

- Persist a manually selected local mount directory in the current platform's
  configuration.
- Open manually selected remote folders in a new VS Code window so the current
  mounted workspace remains open.
- Localize the remote-folders view, command entries, and context menus in
  Chinese.

## 0.9.3

- Confirm the resolved local mount directory before opening a remote folder,
  with an option to choose another local directory for the current operation.

## 0.9.2

- Fall back to `diskutil unmount` when a normal macOS unmount reports that the
  SSHFS mount is busy.
- Pass the documented reuse-window argument to `vscode.openFolder`, restoring
  automatic folder switching and remote-terminal creation after mounting.

## 0.9.1

- Activate immediately after installation so the initial missing-dependency
  check and installation prompt are shown without requiring a VS Code restart
  or another extension command.

## 0.9.0

- Add a dedicated Serverless Remote SSH activity-bar view listing configured
  remote folders and their current mount status.
- Open remote folders and terminals or disconnect active mounts directly from
  the view.
- Add title-bar actions for creating configurations and refreshing the view,
  with configuration, status, and dependency commands available from the
  overflow menu.
- Show guided empty and configuration-error states without changing the
  existing command-palette workflows.

## 0.8.15

- Make `Open Remote Terminal` create a new SSH terminal every time, while
  retaining terminal reuse for automatic workspace connection and recovery.

## 0.8.14

- Treat configured `local_paths` and `local_path` values as fixed mount
  locations instead of recalculating paths that end with the mount name from
  the current workspace.

## 0.8.13

- Serialize mount, open-folder, and unmount orchestration using normalized
  per-mount paths.
- Prevent automatic workspace remounting from deadlocking by avoiding nested
  acquisition of the same mount lock.

## 0.8.10

- Preserve empty workspace subdirectories after session-owned mounts are
  unmounted, preventing VS Code from reporting a missing workspace on restart.
- Show a remounting notification while safely restoring mounts that contain
  only empty workspace placeholder directories.

## 0.8.9

- Restore VS Code workspaces opened below a configured mount root by mounting
  the missing ancestor first, then opening the SSH terminal in the matching
  remote subdirectory.
- Cache and parallelize dependency checks, reuse configuration and mount state,
  and report connection-phase timings in the output channel.
- Reuse Linux/macOS and WSL bridge SSH connections, overlap independent
  Windows startup work, and add configurable SSHFS cache profiles.
- Recheck cached missing dependencies after bridge installation and always
  search `~/.local/bin` even when the VS Code extension host has an older PATH.
- Remember a successful dependency check permanently per platform; automatic
  startup checks resume only until the platform first passes, while the manual
  dependency command always performs a fresh check.

## 0.8.8

- Remove extension-level mount and SSH connection deadlines and forced process
  termination on every platform, preserving each native command's own timeout
  behavior and error output.
- Wait for VS Code mount tasks to finish naturally and use their exit codes
  before checking mount status.

## 0.8.7

- Install the WSL VPN bridge from a temporary clone, retaining only its
  uninstall script after setup.
- Run the retained bridge cleanup script when the VS Code extension is
  uninstalled.

## 0.8.6

- Automatically mount an opened configured mount directory when it is empty
  and not mounted, then open its matching remote terminal on every platform.

## 0.8.5

- Prompt to run `Serverless Remote SSH: Open Remote Terminal` when a managed
  SSH terminal exits because its local bridge process ended.
- Let the VS Code extension exclusively manage remote terminals instead of
  relying on the retired Bash prompt hook from `wsl-vpn-ssh-bridge`.

## 0.8.4

- Force-stop SSHFS/FUSE process groups that ignore `SIGTERM`, ensuring the
  fixed 8-second connection timeout actually completes.
- Resolve WSL bridge executables through the login shell so tools installed in
  `~/.local/bin` remain available to the VS Code extension host.
- Do not launch the WSL bridge from inside its mount point, avoiding misleading
  `spawn ENOENT` errors when a previous FUSE mount is disconnected.
- Recognize SSH connection resets and similar network failures, and avoid
  repeating streamed bridge output inside the final failure line.

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
