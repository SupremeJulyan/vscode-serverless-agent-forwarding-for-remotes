# SAFS

**S**erverless **A**gent **F**orwarding for **SSH**

[简体中文](README.md) | [English](README_EN.md)

通过 SFTP 在 VS Code 中直接浏览和编辑远程文件，并通过 SSH 打开远程终端，
无需在服务器安装 VS Code Server，也无需安装 SSHFS、FUSE 或 WinFsp。

## 功能

- 使用 `safs://` 虚拟工作区直接显示远程目录。
- 浏览、打开、保存、新建、重命名和删除远程文件及目录。
- 密码或私钥认证；配置密码可通过主口令加密。
- SFTP 连接池、断线重试、元数据缓存和远程文件轮询。
- 从当前远程文件或工作区打开相同目录下的 SSH 终端。
- 每个远程配置记住最后切换的目录，重新打开时恢复工作区和终端目录。
- 远程文件夹侧栏显示连接状态，可打开、断开或删除配置。
- GitHub Copilot Language Model Tools 和本机 MCP 服务可直接列出、读取、写入、
  搜索远程文件，并通过 SSH 执行远程命令。

## 使用

1. 安装 `safs-1.0.5.vsix`。
2. 运行 `SAFS: 添加 SSH 配置`。
3. 输入配置名称、`user@host`，并选择密码或私钥认证。
4. 运行 `SAFS: 打开远程文件夹`。
5. 在资源管理器中直接编辑远程文件。
6. 使用 `SAFS: 断开 SFTP 连接` 关闭连接。

```sh
code --install-extension safs-1.0.5.vsix
```

## 配置

所有平台统一使用 `~/.safs/config.json`。

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

顶层 `mounts` 数组定义 SFTP 远程文件夹；远程目录不会挂载到本地文件系统。

## Agent 工具

VS Code Agent 可使用：

- `#safsList`
- `#safsRead`
- `#safsWrite`
- `#safsSearch`
- `#safsRun`

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
Claude Code 注册同一个由扩展进程托管的固定 Streamable HTTP MCP 路由器，并在每次工具
调用时找到目标窗口的最新动态端口。Agent 不再启动 STDIO 路由子进程，因此不会继承
`safs` 虚拟工作区 cwd。省略 `mountName` 时使用
当前获得焦点且状态最新的窗口；显式提供 `mountName` 时选择对应的活动挂载。窗口服务只能
访问其绑定挂载，不能通过请求参数跨窗口访问。

某些 Agent 扩展仍会把虚拟 URI 的 POSIX 路径当成本机 cwd 并在启动时调用
`lstat` 或创建 Git watcher。开启 Agent 转发时，扩展会在用户级扩展存储中创建空的
占位目录，并在第一个不存在的本机路径段建立 Windows Junction 或 Linux/macOS
目录符号链接。该目录不包含或同步远程文件，只用于让 Agent 完成本机启动。扩展不会
覆盖已存在的本机路径；如果父目录权限不允许创建链接，会在输出面板中报告。

窗口发现、目标选择、动态端口路由、断线判断、挂载校验和远程工具说明全部由扩展内置的
HTTP 路由器完成，不安装 Codex 插件、Skill 或 hooks。多个 VS Code 窗口通过固定端口选出
一个 Router Leader；Leader 关闭后，其他窗口会自动接管。MCP instructions
会要求 Agent 对 `safs` 工作区只使用远程
工具；由于 MCP 无法拦截客户端自身的本地工具，该约束依赖 Agent 遵循工具说明。

“启用 Agent 转发”会先为检测到的 Codex 和 Claude Code 安装或更新名为
`safs` 的固定 HTTP MCP；如果当前已打开该远程目录，还会立即启动该窗口的
动态端口 MCP 服务。关闭某个挂载的 Agent 转发会停止该窗口服务；只有最后一个已启用挂载
也被关闭后，扩展才会执行 `mcp remove`。首次安装、更新或移除 MCP 后请重启 Agent 并
新建对话。

扩展会生成鉴权令牌并自动执行等价于以下形式的配置：

```sh
codex mcp add safs --url 'http://127.0.0.1:9848/mcp?token=<generated-token>'
claude mcp add --transport http --scope user safs 'http://127.0.0.1:9848/mcp?token=<generated-token>'
```

如果未安装 Agent CLI，可在 VS Code 命令面板执行
**SAFS: 复制桌面版 Agent MCP 地址**，然后在桌面版
**Settings > MCP servers** 中添加名为 `safs` 的
**Streamable HTTP** 服务器并粘贴该地址。地址包含鉴权令牌，不要共享或
提交到仓库。

安装后重启 Agent 并新建对话。VS Code 扩展必须保持运行，并为相应挂载开启“Agent 转发”。断开 SFTP
不会关闭 Agent 转发偏好，重连相同挂载后 MCP 会发现新端口。如果同时打开多个远程窗口，
省略 `mountName` 的工具调用使用当前获得焦点且状态最新的窗口。设置
`safs.agentMcpPort` 应保持为默认值 `0`；固定入口端口由
`safs.agentHttpRouterPort` 控制，默认是 `9848`。如果该端口被其他程序占用，
扩展会拒绝连接并提示更换端口，不会误连到未知服务。

## 限制

- 本地命令行程序不能直接访问 `safs://` 文件。
- 只支持 `file://` 工作区的第三方 VS Code 扩展可能无法使用。
- SFTP 没有原生文件变更通知，扩展使用定时轮询检测外部修改。
- WSL 的 `vpn: true` 配置复用 `wsl-vpn-ssh-bridge` 的 Windows TCP 中继；
  使用该模式前需要安装 bridge。`vpn: false` 时 SFTP 直接连接目标地址。

## 设置

- `safs.configPath`
- `safs.reuseSshConnection`
- `safs.sftp.cacheTtl`
- `safs.sftp.watchInterval`
- `safs.agentMcpPort`
- `safs.agentHttpRouterPort`
- `safs.agentForwardingAgents`：选择启用 MCP 转发的 Agent，默认
  `codex` 和 `claudeCode`。扩展优先从 `PATH` 查找支持 `mcp` 指令的 CLI，找不到时再从
  对应的 VS Code Agent 扩展安装路径查找内置 CLI。
- `safs.highRiskCommandPatterns`：Agent 通过 MCP 请求远程命令时的高危匹配规则（正则数组），
  默认包含递归删除、磁盘/分区/文件系统操作、关机重启、管道执行远程脚本，以及 `sudo`/`su`/
  `doas`/`pkexec`/`runas`、setuid/setgid、账号管理、`visudo`/`sudoers` 等提权操作。命中即按
  `safs.highRiskCommandAction` 处理；设为 `[]` 可关闭拦截。匹配会忽略引号内的内容，避免搜索
  “sudo” 这类关键词时误伤。
- `safs.highRiskCommandAction`：`deny`（默认）直接拒绝高危命令并记录日志；`confirm` 则每次
  执行前弹窗让用户确认。
