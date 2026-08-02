# Serverless Remote SSH

[简体中文](README.md) | [English](README_EN.md)

通过 SFTP 在 VS Code 中直接浏览和编辑远程文件，并通过 SSH 打开远程终端，
无需在服务器安装 VS Code Server，也无需安装 SSHFS、FUSE 或 WinFsp。

## 功能

- 使用 `serverless-sftp://` 虚拟工作区直接显示远程目录。
- 浏览、打开、保存、新建、重命名和删除远程文件及目录。
- 密码或私钥认证；配置密码可通过主口令加密。
- SFTP 连接池、断线重试、元数据缓存和远程文件轮询。
- 从当前远程文件或工作区打开相同目录下的 SSH 终端。
- 远程文件夹侧栏显示连接状态，可打开、断开或删除配置。
- GitHub Copilot Language Model Tools 和本机 MCP 服务可直接列出、读取、写入、
  搜索远程文件，并通过 SSH 执行远程命令。

## 使用

1. 安装 `vscode-serverless-remote-ssh-1.0.0.vsix`。
2. 运行 `Serverless Remote SSH: 添加 SSH 配置`。
3. 输入配置名称、`user@host`，并选择密码或私钥认证。
4. 运行 `Serverless Remote SSH: 打开远程文件夹`。
5. 在资源管理器中直接编辑远程文件。
6. 使用 `Serverless Remote SSH: 断开 SFTP 连接` 关闭连接。

```sh
code --install-extension vscode-serverless-remote-ssh-1.0.0.vsix
```

## 配置

默认配置文件：

- Windows、macOS、Linux：`~/serverless-remote-ssh/config.json`
- WSL：`~/.wsl-vpn-ssh/config.json`

```json
{
  "encrypt_passwords": true,
  "hosts": [
    {
      "name": "dev",
      "ip": "10.0.0.2",
      "user": "alice",
      "port": 22,
      "private_key_path": "~/.ssh/id_ed25519"
    }
  ],
  "mounts": [
    {
      "name": "project",
      "host": "dev",
      "remote_path": "/srv/project",
      "remote_terminal": "open"
    }
  ]
}
```

为兼容旧配置，顶层数组仍叫 `mounts`；1.0.0 不再读取 `local_path` 和
`local_paths`，远程目录不会挂载到本地文件系统。

## Agent 工具

VS Code Agent 可使用：

- `#serverlessRemoteList`
- `#serverlessRemoteRead`
- `#serverlessRemoteWrite`
- `#serverlessRemoteSearch`
- `#serverlessRemoteRun`

扩展还在 `127.0.0.1` 上提供令牌保护的 Streamable HTTP MCP 服务，工具包括
`resolve_workspace_execution`、`list_remote_folders`、`remote_list`、`remote_read`、`remote_write`、
`remote_search` 和 `run_remote_command`。

Agent 会在会话开始时通过 `resolve_workspace_execution` 识别当前 SFTP 虚拟工作区。
开启转发后，文件工具可省略 `mountName` 并自动绑定当前工作区。所有远程文件访问
都通过 SFTP 工具完成，构建、测试、Git 和系统检查通过 SSH 远程命令完成；工具被
限制在已开启转发的 `remote_path` 内。远端根目录的 `AGENTS.override.md` 或
`AGENTS.md` 会作为工作区指引随路由结果提供给 Agent，不会写入本机用户目录。

### Codex 插件（Windows App / CLI / VS Code）

每个开启 AI 转发的远程 VS Code 窗口会启动独立的动态端口 MCP，并按挂载注册为
`serverless-remote-<mountName>`。例如 `dev1`、`dev2`、`dev3` 分别注册三个互不复用的
服务，每个服务只能访问其绑定挂载，不能通过传入其他 `mountName` 跨窗口访问。

仓库内的 `plugins/serverless-remote` Codex 插件会为每个新会话发现当前获得焦点的
Serverless Remote VS Code 窗口。发现远程窗口后，`SessionStart` hook 会把该窗口绑定到
Codex 会话，并要求调用该窗口精确 MCP 服务的 `resolve_workspace_execution`；`PreToolUse` hook 会阻止该会话
使用本地 shell 或本地文件编辑工具误操作虚拟工作区。

本地开发安装：

```sh
codex plugin marketplace add /path/to/vscode-serverless-remote-ssh
codex plugin add serverless-remote@personal
```

安装后在 Codex 中审核并信任插件 hooks，然后重启 Codex 并新建对话。Windows Codex
原生模式使用 `%USERPROFILE%` 中的窗口发现记录；WSL 模式会同时尝试 WSL home 和
Windows 用户目录。VS Code 扩展必须保持运行，并为相应挂载开启“AI 转发”。如果同时
打开多个远程窗口，创建会话时优先绑定当前获得焦点且状态最新的窗口。设置
`serverlessRemote.agentMcpPort` 应保持为默认值 `0`；配置固定端口会重新引入多窗口端口冲突。

## 限制

- 本地命令行程序不能直接访问 `serverless-sftp://` 文件。
- 只支持 `file://` 工作区的第三方 VS Code 扩展可能无法使用。
- SFTP 没有原生文件变更通知，扩展使用定时轮询检测外部修改。
- WSL 的 `vpn: true` 配置复用 `wsl-vpn-ssh-bridge` 的 Windows TCP 中继；
  使用该模式前需要安装 bridge。`vpn: false` 时 SFTP 直接连接目标地址。

## 设置

- `serverlessRemote.configPath`
- `serverlessRemote.reuseSshConnection`
- `serverlessRemote.sftp.cacheTtl`
- `serverlessRemote.sftp.watchInterval`
- `serverlessRemote.agentMcpPort`
