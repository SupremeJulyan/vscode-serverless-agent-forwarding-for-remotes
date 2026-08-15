# SAFS

**S**erverless **A**gent **F**orwarding for **SSH**

[简体中文](README.md) | [English](README_EN.md)

Browse and edit remote files directly in VS Code over SFTP and open real SSH
terminals without installing VS Code Server. Enable Agent Forwarding to let
VS Code agents and desktop agents (Codex, Claude Code, ...) read, write, and
search remote files and run remote commands over SSH through MCP. Built for
intranet hosts and remote servers that forbid port forwarding.

## Features

- Opens remote folders as `safs://` virtual workspaces.
- Browse, read, save, create, rename, and delete remote files and directories.
- Password and private-key authentication with optional master-password encryption.
- Pooled SFTP connections, metadata caching, reconnect support, and file polling.
- Opens SSH terminals in the directory selected in the remote workspace.
- Remembers the last switched directory per remote configuration and restores its workspace and terminal there.
- Direct remote list/read/write/search tools for VS Code agents and MCP clients.
- Runs builds, tests, Git, and system commands remotely over SSH.

## Usage

### Install

```sh
code --install-extension safs-serverless-agent-forwarding-1.1.1.vsix
```

### Add an SSH config and open a remote folder

1. Run `SAFS: Add SSH Config`.
2. Enter a name, `user@host`, and choose password or private-key auth.
3. Run `SAFS: Open Remote Folder` and pick the config you just added; you can
   also click the "Open Remote Folder" button on the connection item in the
   SAFS view (Remote Folders) in the Activity Bar.
4. The remote directory opens as a `safs://` virtual workspace; edit remote
   files directly in the Explorer.
5. Run `SAFS: Disconnect` when finished (or use the "Disconnect" button on
   the connection item).

### Open a remote terminal

Remote terminals connect over SSH; no VS Code Server is required on the host.

- Run `SAFS: Open Remote Terminal` from the Command Palette.
- Or click the "Open Remote Terminal" button on a connection item in the SAFS
  view.
- The terminal opens in the current remote directory: the directory of the
  active remote file when there is one, otherwise the mount root (or the last
  remembered directory). Terminal names look like
  `SSH: <name> — <relative path>`.
- With `remote_terminal: "open"`, a terminal is connected automatically after
  opening the remote folder.

### Open the remote directory

- Run `SAFS: Open Remote Directory` from the Command Palette.
- Type a path inside the mount root, or pick a candidate from the completion
  list, then press Enter. The directory opens in a **new window** (only real
  directories inside the mount root are accepted); the current window stays
  open, and each window's Agent-forwarding/MCP stays bound to its own
  directory.
- Each remote config remembers the last opened directory; reopening the
  remote folder restores both the workspace and the terminal there.

### Enable Agent Forwarding

The Agent can be a VS Code extension (Copilot Chat, Codex, ...) or a desktop
app (Codex CLI, Claude Code, ...), but it must run on the same operating
system platform as the VS Code window hosting SAFS: the MCP endpoint is
loopback-only (`127.0.0.1`) and cannot be reached across machines or
platforms.

1. First click the "Enable Agent Forwarding" button on the connection item in
   the SAFS view (or pick the same command from its context menu). The
   extension installs or updates the fixed `safs` HTTP MCP for the detected
   Agent CLIs (default `codex`, `claude`, `pi`, and `dsh`; extend with
   `safs.agentForwardingAgents`).
2. Verify the registration: open the Agent and type `/mcp` (or open its MCP
   management view); seeing the `safs` entry means the MCP was registered
   successfully. If the Agent is a VS Code extension, just confirm it in the
   Agent session of the new window.
3. Then run `SAFS: Open Remote Folder` to enter the remote directory (or click
   the "Open Remote Folder" button on the connection item). Before creating
   the new window, the extension starts the fixed HTTP router and registers
   the Agent. The new window starts its dynamic-port service, and the Agent
   conversation binds to the remote window automatically via
   `resolve_workspace_execution`; tool calls no longer need `mountName`.
4. Restart the Agent and start a new conversation (required after installing,
   updating, or removing MCP).
5. The Agent can now use the remote tools directly: `#safsList`, `#safsRead`,
   `#safsWrite`, `#safsSearch`, and `#safsRun` for VS Code agents, or the MCP
   tools `resolve_workspace_execution`, `list_remote_folders`, `remote_list`,
   `remote_read`, `remote_write`, `remote_search`, and `run_remote_command`.
6. To disable: click "Disable Agent Forwarding" on the connection item. The
   extension runs `mcp remove` only after the last enabled mount is disabled.

#### Multiple remote windows

- When several remote windows are open, they all share the same fixed HTTP MCP
  entry; the windows elect one Router Leader on the fixed port, and another
  window takes over when the leader exits.
- Tool calls without `mountName` bind to the focused, most recently updated
  window; an explicit `mountName` selects that active mount.
- Each window's dynamic-port service can only access its own mount and cannot
  reach other mounts through request parameters.

#### Determine which remote the Agent session is bound to

- Call `resolve_workspace_execution` at the start of the conversation: the
  `mountName` in the returned JSON (with `name`, `remoteRoot`, `host`, and
  `focused`) is the current binding. The MCP instructions require calling it
  first and reusing the returned `mountName` to keep the binding stable.
- `current_remote_workspace` returns the focused active remote folder
  directly; `list_remote_folders` lists all active Agent-forwarded mounts.
- Without `mountName`, the router prefers the focused window, then the most
  recently updated one: the remote window that has focus wins; when none has
  focus, the most recently interacted window is used.
- On the VS Code side, run `SAFS: Show Status` to see each mount's connection
  state in the output panel.

## Configuration

All platforms use `~/.safs/config.json`.

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

The top-level `mounts` array defines SFTP remote folders. Remote directories are
not mounted into the local filesystem.

## Agent access

VS Code tools: `#safsList`, `#safsRead`,
`#safsWrite`, `#safsSearch`, and
`#safsRun`.

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
dynamically allocated port. The extension registers the same stable Streamable HTTP MCP
router, hosted inside the extension process, for Codex and Claude Code. Agents no longer
spawn a stdio router process and therefore cannot inherit a `safs` virtual cwd.
The router resolves the target window's latest port on every call. Calls without `mountName`
use the focused, most recently updated window; an explicit `mountName` selects that active
mount. Each window service remains restricted to its own mount.

Some Agent extensions still treat the virtual URI's POSIX path as a native cwd and call
`lstat` or start a Git watcher during startup. When Agent forwarding is enabled, this
extension uses a real, empty workspace cwd inside per-user extension storage. The SFTP
provider maps that URI namespace back to the actual remote root, so no directory or
symbolic link is created at the remote machine's absolute path and administrator access
is not required. The placeholder contains no remote files and exists only to let Agents
finish native startup. Workspaces opened by older versions must be reopened from the
SAFS view to use the new URI namespace.

Window discovery, target selection, dynamic-port routing, disconnect detection,
mount validation, and remote-tool guidance all live in the extension-hosted HTTP router. VS Code
windows elect one router leader by claiming the fixed port, and another window takes over when
that leader exits. The
integration does not install a Codex plugin, skill, or hooks. MCP instructions tell agents to use only
remote tools for `safs` workspaces; because MCP cannot intercept a client's
own local tools, enforcement depends on the agent following those instructions.

Enable Agent Forwarding first installs or updates the fixed `safs` HTTP MCP
for detected Codex and Claude Code installations. If that remote folder is already open,
the action also starts its window-scoped dynamic-port MCP service immediately. Disabling
a mount stops its window service; the extension runs `mcp remove` only after the last
enabled mount is disabled. Restart the Agent and start a new conversation after installing,
updating, or removing MCP.

The extension generates an authentication token and automatically applies configurations
equivalent to:

```sh
codex mcp add safs --url 'http://127.0.0.1:9848/mcp?token=<generated-token>'
claude mcp add --transport http --scope user safs 'http://127.0.0.1:9848/mcp?token=<generated-token>'
```

If no Agent CLI is installed, run **SAFS: Copy Desktop Agent MCP
URL** from the VS Code Command Palette. In the desktop app, open **Settings > MCP
servers**, add a **Streamable HTTP** server named `safs`, and paste the
copied URL. The URL contains an authentication token; do not share it or commit it
to the repository.

Restart the Agent and start a new conversation. The VS Code extension must remain running with Agent forwarding enabled for the
mount. Disconnecting SFTP preserves that preference, and MCP discovers the new port after
the mount reconnects. If multiple remote windows are open, calls without `mountName` use
the focused, most recently updated window. Keep `safs.agentMcpPort` at its
default value of `0`. `safs.agentHttpRouterPort` controls the stable Agent-facing
port and defaults to `9848`; the extension rejects an unrelated process occupying that port.

## Limitations

- Local command-line programs cannot access `safs://` files.
- Extensions that only support `file://` workspaces may be unavailable.
- SFTP has no native change notifications, so external changes are polled.
- When a server only offers legacy host keys (`ssh-rsa`/`ssh-dss`, disabled by
  default since OpenSSH 8.8), the extension automatically re-enables them on
  every connection path (system `ssh`, WSL bridge, built-in SFTP/terminal).
- When a server only accepts `keyboard-interactive` auth (e.g. NSG/company
  gateways), both the SFTP and terminal paths answer the interactive prompts
  with the configured password automatically.
- When the built-in terminal is rejected at the pty/shell level (e.g. NSG
  gateway appliances), the extension automatically retries with the system
  `ssh` CLI.
- Some NSG/gateways whitelist SSH clients by identification string (MobaXterm
  works because it uses a PuTTY banner; `ssh2js` gets rejected). The
  extension now presents itself as `OpenSSH_9.6` by default on SFTP/built-in
  terminal connections; set `safs.sshClientIdent` to e.g. `PuTTY_Release_0.78`
  if the default is still rejected.
- When the server has no SFTP subsystem (e.g. old-OpenSSH NSG gateways
  without sftp-server), remote folders automatically fall back to an
  exec/SCP transport — the same mechanism MobaXterm's file browser uses — so
  the file tree, read/write/search and Agent MCP tools keep working.
  Directory listing / path resolution prefer GNU commands
  (`find -printf`/`readlink -f`) and fall back to `ls`/`pwd` parsing on
  BSD/macOS/Solaris servers.
- WSL configurations with `vpn: true` reuse the Windows TCP relay supplied by
  `wsl-vpn-ssh-bridge`; install the bridge before using that mode. With
  `vpn: false`, SFTP connects directly.

## Settings

- `safs.agentMcpPort`: dynamic per-window backend port; keep the default `0`.
- `safs.agentHttpRouterPort`: stable Agent-facing HTTP router port; defaults to `9848`.
- `safs.agentForwardingAgents`: selects Agents enabled for MCP forwarding;
  defaults to `codex`, `claude`, `pi`, and `dsh`. Values are the Agent CLI
  command names directly (e.g. `codex`, `claude`, `pi`, `dsh`); any CLI is
  accepted. The extension
  first searches `PATH` for a CLI supporting the `mcp` instruction; if it is not
  found, it looks inside the corresponding installed VS Code extension. CLIs
  without an `mcp` subcommand are skipped and reported. `pi` is handled by a
  built-in file-based handler: the SAFS URL is written to the
  `pi-mcp-extension` config file (`~/.pi/agent/mcp.json`), no `pi mcp add`
  needed. **Using `pi` requires installing `pi-mcp-extension` in pi**
  (`pi install npm:pi-mcp-extension`) and restarting the pi session after
  enabling forwarding so the tools load. `dsh` (DeepSeek Harness) also has no
  `mcp` subcommand; its built-in handler writes an
  `@deepseek-ai/dsh-mcp-client` plugin entry into `$DSH_HOME/cordis.patch.yml`
  (default `~/.dsh/cordis.patch.yml`), which DSH hot-applies through its
  config HMR watch without a restart.
- `safs.agentPlatform`: the Agents' working location; defaults to `auto` (same
  platform as the extension). Choose `wsl` when the extension runs on Windows
  but the Agents run inside WSL: MCP registration reads/writes the Agents'
  config files under the WSL home (`~/.pi/agent/mcp.json`,
  `$DSH_HOME/cordis.patch.yml`), and Agent CLIs (`codex`/`claude`) are detected
  and executed through `wsl.exe` inside WSL.

