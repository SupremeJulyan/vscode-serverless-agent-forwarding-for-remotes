# SAFS

**S**erverless **A**gent **F**orwarding for **SSH**

[简体中文](README.md) | [English](README_EN.md)

通过 SFTP 在 VS Code 中直接浏览和编辑远程文件，并通过 SSH 打开远程终端，
无需在服务器安装 VS Code Server。开启 Agent 转发后，VS Code Agent 与
桌面版 Agent（Codex、Claude Code 等）可通过 MCP 直接读写、搜索远程文件，
并通过 SSH 执行远程命令。适用于内网环境、禁止端口转发的远程服务器。

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

### 安装

```sh
code --install-extension safs-serverless-agent-forwarding-1.1.1.vsix
```

### 添加 SSH 配置并打开远程文件夹

1. 运行 `SAFS: 添加 SSH 配置`。
2. 输入配置名称、`user@host`，并选择密码或私钥认证。
3. 运行 `SAFS: 打开远程文件夹`，选择刚添加的配置；也可以在左侧活动栏的
   SAFS 视图（远程文件夹）中点击连接项上的“打开远程文件夹”按钮。
4. 远程目录以 `safs://` 虚拟工作区打开，直接在资源管理器中编辑远程文件。
5. 使用 `SAFS: 断开 SFTP 连接` 关闭连接（或点击连接项上的“断开连接”按钮）。

### 打开远程终端

远程终端通过 SSH 建立，不需要在服务器安装 VS Code Server。

- 在命令面板运行 `SAFS: 打开远程终端`。
- 或在 SAFS 视图的远程文件夹连接项上点击“打开远程终端”按钮。
- 终端会在当前远程目录打开：有打开的远程文件时使用其所在目录，否则使用
  挂载根目录（或上次记住的目录）。终端名称形如 `SSH: <配置名> — <相对路径>`。
- 配置 `remote_terminal: "open"` 时，打开远程文件夹后会自动连接终端。

### 打开远程目录

- 在命令面板运行 `SAFS: 打开远程目录`。
- 输入挂载根目录内的路径，或从补全列表选择候选目录后回车，会在**新窗口**中打开
  该目录（只能打开挂载根目录内真实存在的目录）；**当前窗口保持不变**，两个窗口
  各自的 Agent 转发/MCP 独立绑定各自目录。
- 每个远程配置会记住最后切换的目录；重新打开远程文件夹时，工作区和终端
  都会恢复到该目录。

### 启用 Agent 转发

Agent 可以是 VS Code 扩展（Copilot Chat、Codex 等），也可以是桌面 App
（Codex CLI、Claude Code 等），但必须和运行 SAFS 的 VS Code 处于同一个
操作系统平台：MCP 地址是仅回环可访问的 `127.0.0.1`，跨机器或跨系统无法
连接。

1. 先在 SAFS 视图的远程文件夹连接项上点击“启用 Agent 转发”按钮（或右键菜单
   中选择同一命令）。扩展会为检测到的 Agent CLI（默认 `codex`、`claude`、
   `pi` 和 `dsh`，可用 `safs.agentForwardingAgents` 扩展）安装或更新名为
   `safs` 的固定 HTTP MCP。
2. 验证注册：打开 Agent 并输入 `/mcp`（或打开其 MCP 管理界面），看到
   `safs` 条目即表示 MCP 注册成功。Agent 若是 VS Code 扩展，直接在新窗口的
   Agent 会话中确认即可。
3. 再运行 `SAFS: 打开远程文件夹` 进入远程目录（或点击连接项上的“打开远程
   文件夹”按钮）。打开前扩展会先启动固定 HTTP 路由并注册 Agent；新窗口会
   启动该窗口的动态端口服务，Agent 会话通过 `resolve_workspace_execution`
   自动绑定当前远程窗口，之后工具调用无需指定 `mountName`。
4. 重启 Agent 并新建对话（首次安装、更新或移除 MCP 后都需要）。
5. 之后 Agent 可直接使用远程工具：VS Code Agent 的 `#safsList`、
   `#safsRead`、`#safsWrite`、`#safsSearch`、`#safsRun`，或 MCP 工具
   `resolve_workspace_execution`、`list_remote_folders`、`remote_list`、
   `remote_read`、`remote_write`、`remote_search`、`run_remote_command`。
6. 关闭转发：点击连接项上的“关闭 Agent 转发”。只有最后一个启用挂载也被
   关闭后，扩展才会执行 `mcp remove`。

#### 多个远程窗口

- 同时打开多个远程窗口时，所有窗口共用同一个固定 HTTP MCP 入口；窗口之间
  通过固定端口选举一个 Router Leader，Leader 关闭后其他窗口自动接管。
- 省略 `mountName` 的工具调用绑定到当前获得焦点且状态最新的窗口；显式传入
  `mountName` 时选择对应的活动挂载。
- 每个窗口的动态端口服务只能访问自己绑定的挂载，不能通过请求参数跨窗口
  访问其他挂载。

#### 确认 Agent 会话绑定哪个远程

- 会话开始时先调用 `resolve_workspace_execution`：返回 JSON 中的
  `mountName`（以及 `name`、`remoteRoot`、`host`、`focused`）就是当前
  绑定。MCP 指令要求每个会话先调用它，并复用返回的 `mountName` 保持绑定
  稳定。
- 也可调用 `current_remote_workspace` 直接查看当前获得焦点的活动远程
  文件夹，或用 `list_remote_folders` 查看所有已开启转发的活动挂载。
- 省略 `mountName` 时，路由器按“获得焦点的窗口优先、其次最近更新”选择：
  哪个远程窗口处于焦点就绑定哪个；都没有焦点时绑定最近交互的窗口。
- VS Code 侧可运行 `SAFS: 显示状态` 在输出面板查看各挂载的连接状态。

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
- 目标服务器只提供旧式主机密钥（`ssh-rsa`/`ssh-dss`，OpenSSH 8.8+ 默认禁用）时，
  扩展会在所有连接路径（系统 `ssh`、WSL bridge、内置 SFTP/终端）自动重新启用这些算法。
- 服务器只接受 `keyboard-interactive` 认证（如 NSG/公司网关）时，SFTP 与终端路径
  都会用配置的密码自动应答交互式提示。
- 内置终端被服务器拒绝 pty/shell（如 NSG 网关设备）时，会自动改用系统 `ssh` 重连。
- 部分 NSG/网关按客户端标识白名单放行（MobaXterm 用 PuTTY 标识可以连，ssh2js 被拒）。
  插件默认把 SFTP/内置终端的客户端标识伪装为 `OpenSSH_9.6`，可用设置
  `safs.sshClientIdent` 改为 `PuTTY_Release_0.78` 等。
- 服务器没有 SFTP 子系统（如老版本 OpenSSH 未装 sftp-server 的 NSG 网关）时，
  远程文件夹会自动降级到 SCP/exec 传输（与 MobaXterm 文件浏览器同机制），
  文件树、读写、搜索与 Agent MCP 工具均可继续使用。列目录/路径解析优先使用
  GNU 命令（`find -printf`/`readlink -f`），BSD/macOS/Solaris 等非 GNU 服务器
  会自动回退到 `ls`/`pwd` 解析。
- WSL 的 `vpn: true` 配置复用 `wsl-vpn-ssh-bridge` 的 Windows TCP 中继；
  使用该模式前需要安装 bridge。`vpn: false` 时 SFTP 直接连接目标地址。

## 设置

- `safs.terminalFollowsActiveFile`：切换/打开远程文件时实时把终端 `cd` 到文件所在目录（默认 `false`）；打开远程终端和重开远程窗口始终跟随活动文件目录，与此设置无关）
- `safs.configPath`
- `safs.reuseSshConnection`
- `safs.sftp.cacheTtl`
- `safs.sftp.watchInterval`
- `safs.agentMcpPort`
- `safs.agentHttpRouterPort`
- `safs.agentForwardingAgents`：选择启用 MCP 转发的 Agent，默认
  `codex`、`claude`、`pi` 和 `dsh`。配置值直接使用 Agent 的 CLI 命令名（如 `codex`、
  `claude`、`pi`、`dsh`），支持任意 CLI。扩展优先从 `PATH` 查找支持 `mcp` 指令的 CLI，
  找不到时再从对应的 VS Code Agent 扩展安装路径查找内置 CLI；检测到 CLI 不支持
  `mcp` 子命令时会跳过并提示。`pi` 通过内置处理器注册：把 SAFS 地址写入
  pi-mcp-extension 的配置文件（`~/.pi/agent/mcp.json`），无需 `pi mcp add`。
  **使用 `pi` 需要先在 pi 中安装 `pi-mcp-extension`**（`pi install npm:pi-mcp-extension`），
  并在启用转发后重启 pi 会话以加载工具。`dsh`（DeepSeek Harness）同样没有
  `mcp` 子命令，由内置处理器把 `@deepseek-ai/dsh-mcp-client` 插件条目写入
  `$DSH_HOME/cordis.patch.yml`（默认 `~/.dsh/cordis.patch.yml`）；DSH 的 HMR
  会热加载该配置，无需重启。
- `safs.agentPlatform`：Agent 所在平台，默认 `auto`（与插件运行平台相同）。
  插件运行在 Windows、Agent 在 WSL 中运行时选择 `wsl`：MCP 注册读写 WSL
  家目录下的配置文件（`~/.pi/agent/mcp.json`、`~/.dsh/cordis.patch.yml`），
  Agent CLI（`codex`/`claude`）也通过 `wsl.exe` 在 WSL 内检测与执行。
- `safs.highRiskCommandPatterns`：Agent 通过 MCP 请求远程命令时的高危匹配规则（正则数组），
  默认包含递归删除、磁盘/分区/文件系统操作、关机重启、管道执行远程脚本，以及 `sudo`/`su`/
  `doas`/`pkexec`/`runas`、setuid/setgid、账号管理、`visudo`/`sudoers` 等提权操作。命中即按
  `safs.highRiskCommandAction` 处理；设为 `[]` 可关闭拦截。匹配会忽略引号内的内容，避免搜索
  “sudo” 这类关键词时误伤。
- `safs.highRiskCommandAction`：`deny`（默认）直接拒绝高危命令并记录日志；`confirm` 则每次
  执行前弹窗让用户确认。
