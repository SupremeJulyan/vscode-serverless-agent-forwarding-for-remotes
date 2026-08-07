# Changelog

## 1.2.1

- Fix remote terminals failing to launch on macOS/Linux (exit code 255):
  `PubkeyAcceptedAlgorithms` is only passed when the installed OpenSSH knows
  it (8.5+), and `ssh-dss` is dropped when the client no longer supports it
  (OpenSSH 10+ removed DSA entirely). Affected old clients include macOS
  Big Sur/Catalina (OpenSSH 8.1) and older Linux distros; OpenSSH 10+ is
  used by macOS Tahoe. The bundled WSL bridge applies the same gating.
- Keep Agent MCP tool paths in sync with the switched remote directory:
  `resolve_workspace_execution` / `current_remote_workspace` now report the
  currently open remote directory instead of the mount root, and relative
  paths in `remote_list` / `remote_read` / `remote_write` / `remote_search` /
  `run_remote_command` (including the default `remoteCwd`) resolve against it.
  Validation still applies against the mount root.

## 1.2.0

- Switch Remote Directory: replaced the completion dropdown with **Tab
  completion** — type a path, press Tab to complete it to the first matching
  remote directory (or the shared prefix when several match, then to the
  first entry when the prefix is exhausted), Enter switches. No dropdown, no
  click behavior.
- The safs workspace URI now uses the **mount config name directly as the
  authority** (e.g. `safs://node37/…`) when the name is URI-safe, so VS Code's
  status-bar remote indicator shows `node37` instead of `m-6e6f64653337`.
  Names with uppercase/spaces still use the legacy hex form, and old hex
  URIs keep decoding.

## 1.1.15

- Switch Remote Directory picker: drop the confirm button. Clicking (or
  arrow-selecting) a completion item fills the path into the input box and
  refreshes the dropdown with its subdirectories; Enter switches directly.

## 1.1.14

- Fix the invisible "确认" quick-input button: `context-fill` is not
  supported for Uri-based SVG icons (renders transparent), switched to a
  solid fill with a font size that fits the 16px button.

## 1.1.13

- Switch Remote Directory picker: clicking a completion item or pressing Enter
  now only fills the path into the input box (refreshing the dropdown with
  the directory's children for step-by-step browsing); switching happens
  exclusively via the "确认" button at the right end of the input box
  (text-rendered SVG button, replaces the checkmark icon).

## 1.1.12

- Switch Remote Directory picker: clicking (or Enter-ing) a completion item
  now fills the full path into the input box and refreshes the dropdown with
  that directory's subdirectories for step-by-step browsing; Enter again (or
  the new ✓ confirm button) actually switches. Enter with no item selected
  still switches to the typed path directly.

## 1.1.11

- Migrate pi/vscode-pi conversation history: session keys are derived from
  the agent cwd placeholder path, whose prefix changes across platform
  switches (WSL ↔ native Windows) or extension renames, making old
  conversations look lost. On activation the extension now merges session
  files from legacy keys of the same mount into the current key directory
  (best-effort, never deletes, skips collisions).

## 1.1.10

- Cross-platform server support for the SCP fallback: `realpath` now falls
  back to `cd`+`pwd -P` and then a plain normalized path when `readlink -f` is
  unavailable (BSD/macOS/Solaris servers), and `readDirectory` falls back to
  parsing `ls -la --time-style=long-iso` when GNU `find -printf` is missing.
  The ls parser also handles spaces in names, symlinks and setuid/sticky bits.

## 1.1.9

- Fix `(SSH) Channel open failure: open failed` / phantom workspace folders on
  SCP-fallback sessions: NSG gateways reject excess concurrent channels per
  connection, and VS Code fires many parallel explorer/stat/watch calls at
  window startup. ScpSession now serializes channel-opening operations (max 5
  concurrent) and retries transient channel refusals once. Workspace
  preloading also tolerates per-mount failures without a startup error dialog.

## 1.1.8

- Fix "无法打开…找不到该文件" when clicking remote files on SCP-fallback
  sessions: `realpath` now canonicalizes files as well as directories
  (`readlink -f` instead of `cd`+`pwd`), matching SFTP semantics the provider
  relies on. Error codes are also refined so only genuine missing paths are
  reported as not-found (permission and other failures keep their real cause).

## 1.1.7

- SCP fallback filesystem: when the server has no SFTP subsystem (e.g. NSG
  gateways running old OpenSSH without sftp-server, like 10.68.0.1), the
  extension now automatically falls back to an exec/SCP session on the same
  connection — the same mechanism MobaXterm's file browser uses. The remote
  folder, file tree, read/write/search and Agent MCP tools all keep working
  over the legacy SCP protocol plus shell commands (find/stat/mv/mkdir/rm).
  Verified end-to-end against a real sftp-less gateway.

## 1.1.6

- New setting `safs.sshClientIdent` (default `OpenSSH_9.6`): the client
  identification sent after `SSH-2.0-` on all ssh2 connections (SFTP,
  built-in terminal, remote commands). Some NSG/gateway appliances whitelist
  well-known SSH clients (OpenSSH, PuTTY/MobaXterm…) and reject unusual ones
  like `ssh2js`, producing `Unable to start subsystem: sftp` / `Unable to
  request a pseudo-terminal` even though the server supports SFTP. If the
  default is still rejected, try `PuTTY_Release_0.78` (the same banner
  MobaXterm uses).

## 1.1.5

- Terminal auto-fallback: when the built-in ssh2 terminal is rejected by the
  server at the channel level (`Unable to request a pseudo-terminal` /
  `Unable to open shell` — typical of NSG/gateway appliances), the extension
  automatically retries with the system `ssh` CLI instead of giving up.
  Auth/network failures do not trigger the fallback.

## 1.1.4

- Clearer error when the server refuses to start the SFTP subsystem
  (`Unable to start subsystem: sftp`): the dialog now explains that the host
  provides no SFTP subsystem (SSH-terminal-only / gateway policy), points to
  `Subsystem sftp` in sshd_config, and suggests trying the SSH terminal.

## 1.1.3

- Fix `SAFS: All configured authentication methods failed` when opening a
  remote folder whose server only accepts `keyboard-interactive` auth (e.g.
  NSG/company gateways): `connectSftp` now enables `tryKeyboard` and answers
  the interactive prompts with the configured password, matching the terminal
  path. Auth failures now show a Chinese hint to check the username/password.

## 1.1.2

- Fix `Unable to negotiate ... no matching host key type found` (Their offer:
  `ssh-rsa,ssh-dss`) against legacy servers: re-enable `ssh-rsa`/`ssh-dss`
  host key and user key algorithms on every connection path — system `ssh`
  CLI, the bundled WSL `ssh-bridge`, and the ssh2-based SFTP/terminal
  connections. Modern algorithms stay preferred.

## 1.1.1

- Document the full usage flow in README (Chinese and English): open a
  remote SSH terminal, switch the remote directory with path completion, and
  enable Agent Forwarding in the correct order (enable forwarding first, then
  open the remote folder so the Agent plugin in the new window discovers the
  registered `safs` MCP).
- Document Agent requirements and verification: the Agent may be a VS Code
  extension or a desktop app but must run on the same OS platform as SAFS
  (loopback-only `127.0.0.1` MCP); type `/mcp` in the Agent to confirm the
  `safs` entry, then opening the remote window binds the Agent conversation
  to it automatically via `resolve_workspace_execution`.
- Document multiple remote windows: shared fixed HTTP MCP entry with Router
  Leader election, `mountName`-less calls bind to the focused, most recently
  updated window, and how to determine which remote a session is bound to
  (`resolve_workspace_execution`, `current_remote_workspace`,
  `list_remote_folders`, `SAFS: Show Status`).

## 1.1.0

- Read-only MCP tools (`remote_list`, `remote_read`, `remote_search`) now accept paths outside the remote workspace root (e.g. `~/.bashrc`, `/etc/hosts`); they are served directly over SFTP. `remote_write` and `run_remote_command`'s cwd stay restricted to the workspace.
- Smart deletion analysis: `rm`, `find -delete`/`-exec rm`, and `xargs rm` are no longer blocked on sight. Only targets that are system-critical or of uncertain scope are flagged — `/`, system roots (`/etc`, `/usr`, `/bin`, ...), home dir (`~`, `$HOME`), wildcards, `.`/`..`, and `find` with no path or a dangerous root. Concrete safe directories (`rm -rf ./dist`, `find ./src -delete`, `rm -rf /tmp/build`) pass through.
- Smart permission analysis for `chmod`/`chown`: mode/owner targets are checked the same way (`chmod -R 777 /etc`, `chmod -R a=rwx /`, `chown -R root:root /` blocked; `chmod -R 777 ./dist`, `chown -R app:app /opt/app/data` pass).
- Close more bypasses: `\rm` backslash prefix, `sudoedit`, `iptables --flush`, `systemctl stop/disable firewalld|ufw|nftables`, `zfs destroy`, `sgdisk -Z`, `blkdiscard`, `grub2-install`, `chpasswd`, `gpasswd -a`, `adduser x sudo|wheel`, `usermod -aG sudo|wheel`, `mount` with `rw`/`remount` in either order, `echo o > /proc/sysrq-trigger`, `curl|wget ... | dash|python|perl`, and `dd` no longer flags harmless `of=/dev/zero|urandom|null`.
- Extended high-risk command rules: fork bomb, killing init (`kill -9 1`, `pkill -9 init`), SysV `init`/`telinit 0|6`, kernel parameter writes (`sysctl -w`, `/proc/sys`), firewall flush/disable (`iptables -F`, `ufw disable`, `nft flush`), storage/volume destruction (`zpool destroy`, `mdadm --zero-superblock`, `cryptsetup luksFormat/luksErase`, `pvremove`/`vgremove`/`lvremove`), read-only mount override (`mount -o remount,rw /`), bootloader/firmware overwrites (`grub-install`, `efibootmgr`).

## 1.0.9

- Pi support: `pi` in `safs.agentForwardingAgents` is now handled by a built-in file-based handler instead of being skipped. SAFS writes the unified MCP router URL to the `pi-mcp-extension` config file (`~/.pi/agent/mcp.json`) with `streamable-http` transport, so Pi can use SAFS remote tools (`mcp_safs_*`) without an `mcp` subcommand.
  - Detects whether `pi-mcp-extension` is installed (checks both `~/.pi/agent/settings.json` and the `PI_CODING_AGENT_DIR` agent dir) and warns when it is missing.
  - Handler-based agents (pi) skip CLI detection entirely: registration no longer requires `pi` in PATH, so the Pendant VS Code extension's bundled runtime works without a standalone `pi` command.
  - Refactor: all Agent MCP registration (types, built-in definitions, probing and add/get/remove dispatch) moved to a single `src/agent-mcp-registry.ts` module; `extension.ts` keeps only the orchestration. Codex and Claude behavior is unchanged.

## 1.0.8

- `safs.agentForwardingAgents` now uses real Agent CLI names (`codex`, `claude`; the old `claudeCode` value is still accepted for compatibility) and accepts any CLI name instead of a fixed enum.
- Generic Agent support: the extension detects each configured Agent CLI, probes its `mcp` subcommand, and registers the unified `safs` MCP router automatically when supported. CLIs without an `mcp` subcommand (e.g. `pi`) are skipped and reported in the output panel with a warning notification.

## 1.0.7

- Record every remote command executed through Agent MCP (and SAFS commands such as remote search and the command palette) as an append-only line under `~/.safs/mcp_logs/`, one per-day file.
- Intercept high-risk commands requested by Agents (destructive disk/delete operations and privilege escalation such as `sudo`/`su`/`setuid`), configurable via `safs.highRiskCommandPatterns`; default action denies them, `safs.highRiskCommandAction` can switch to per-command confirmation.

## 1.0.6

- Preserve existing remote file permissions when SFTP saves replace a file, while still saving content when the server does not support `chmod`.

## 1.0.5

- Remember the last switched directory for each remote configuration and restore both the workspace and terminal there when it is reopened.

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
