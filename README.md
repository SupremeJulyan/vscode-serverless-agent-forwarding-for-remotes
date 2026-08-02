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

所有平台的新默认配置文件均为 `~/.serverless-remote-ssh/config.json`。
旧路径 `~/serverless-remote-ssh/config.json` 和 WSL 的 `~/.wsl-vpn-ssh/config.json`
仍会自动识别；已有配置无需迁移。

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

Agent 在执行工作区操作前通过 `resolve_workspace_execution` 识别当前 SFTP 虚拟工作区。
开启转发后，文件工具可省略 `mountName` 并自动绑定当前工作区。所有远程文件访问
都通过 SFTP 工具完成，构建、测试、Git 和系统检查通过 SSH 远程命令完成；工具被
限制在已开启转发的 `remote_path` 内。Agent 路由和使用约束由固定 MCP 服务统一管理，扩展
不会在远端创建或读取 Agent 指引文件。

### 统一 Agent MCP（Codex / Claude Code）

每个开启 Agent 转发的远程 VS Code 窗口会启动独立的动态端口 MCP。扩展为 Codex 和
Claude Code 注册同一个固定的
stdio MCP 路由器，并在每次工具调用时找到目标窗口的最新端口。省略 `mountName` 时使用
当前获得焦点且状态最新的窗口；显式提供 `mountName` 时选择对应的活动挂载。窗口服务只能
访问其绑定挂载，不能通过请求参数跨窗口访问。

`resources/agent-mcp` 中的窗口发现、目标选择、动态端口路由、断线判断、挂载校验和远程
工具说明全部由 MCP 路由器完成，不安装 Codex 插件、Skill 或 hooks。MCP instructions
会要求 Agent 对 `serverless-sftp` 工作区只使用远程
工具；由于 MCP 无法拦截客户端自身的本地工具，该约束依赖 Agent 遵循工具说明。

“启用 Agent 转发”按钮只保存该挂载的启用标记，不会立即连接或启动 MCP。之后打开该
远程目录时，新窗口会自动启动 MCP，并为检测到的 Codex 和 Claude Code 安装或更新名为
`serverless-remote` 的固定 stdio MCP，不再弹出 Agent 转发或一键配置确认框。关闭 Agent
转发后，该挂载只使用普通 SFTP/SSH 功能，MCP 工具会拒绝继续访问。首次安装或更新 MCP
后请重启 Agent 并新建对话。

本地开发也可手动安装：

```sh
codex mcp add serverless-remote -- node /path/to/vscode-serverless-remote-ssh/resources/agent-mcp/mcp-router.cjs
claude mcp add --scope user serverless-remote -- node /path/to/vscode-serverless-remote-ssh/resources/agent-mcp/mcp-router.cjs
```

安装后重启 Agent 并新建对话。Windows Codex
原生模式使用 `%USERPROFILE%` 中的窗口发现记录；WSL 模式会同时尝试 WSL home 和
Windows 用户目录。VS Code 扩展必须保持运行，并为相应挂载开启“Agent 转发”。断开 SFTP
不会关闭 Agent 转发偏好，重连相同挂载后 MCP 会发现新端口。如果同时打开多个远程窗口，
省略 `mountName` 的工具调用使用当前获得焦点且状态最新的窗口。设置
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
- `serverlessRemote.agentForwardingAgents`：选择启用 MCP 转发的 Agent，默认
  `codex` 和 `claudeCode`。扩展优先从 `PATH` 查找支持 `mcp` 指令的 CLI，找不到时再从
  对应的 VS Code Agent 扩展安装路径查找内置 CLI。
