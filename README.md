# Serverless Remote SSH

[简体中文](README.md) | [English](README_EN.md)

通过 SSHFS 在 VS Code 中直接编辑远程文件，并在集成终端中使用真正的
SSH 会话，无需在目标主机上安装或运行 VS Code Server。语言服务、扩展和
界面仍在本机运行，远程主机只需要提供 SSH/SFTP。

## 功能特点

- 支持 Windows、macOS、Linux 和 WSL，自动选择对应的平台适配器。
- 将远程目录挂载为操作系统中的真实目录，VS Code 和本地工具可以像处理
  普通文件一样读写远程文件。
- 一条 `Open Remote Folder` 命令完成选择配置、创建挂载目录、检查或恢复
  挂载、切换 VS Code 工作区，并在窗口重载后打开对应的 SSH 终端。
- `Open Remote Terminal` 每次手动执行都会创建新的 SSH 会话，允许同时打开
  任意数量的远程终端。
- 根据当前工作区或活动文件自动匹配挂载配置，并把本地子目录映射到相同的
  远程子目录。直接打开挂载根目录或其子目录时，也会自动恢复挂载和终端。
- 自动连接、窗口恢复和挂载恢复会复用匹配的终端并进行并发去重，避免 VS Code
  重载或多个恢复事件产生重复会话。
- 支持密码和私钥认证。密码使用主口令加密保存，旧版明文密码会在首次使用时
  自动迁移。
- Linux、macOS 和 WSL 可通过 OpenSSH ControlMaster 在 SSHFS 与多个终端之间
  复用 SSH 连接。
- Linux 和 macOS 提供 `fresh`、`balanced`、`fast` 三档 SSHFS 缓存策略。
- 自动检测各平台依赖，并提供安装包链接或适合当前 Linux 发行版的可复制命令。
- 提供挂载状态、WSL 中继状态、连接阶段耗时和错误诊断。
- 支持平台专用挂载路径，以及包含空格、中文、括号、方括号和单引号的本地或
  远程路径。
- 关闭工作区后安全卸载对应挂载；Linux 和 macOS 还会在扩展会话结束时清理
  本次会话创建的挂载。

## 平台支持

| 平台 | 文件挂载 | 远程终端 | 默认挂载位置 | VPN |
| --- | --- | --- | --- | --- |
| Windows | WinFsp + SSHFS-Win | OpenSSH `ssh` | `R:` | 直接使用 Windows 网络环境 |
| macOS | macFUSE + SSHFS | OpenSSH `ssh` | 当前工作区下的配置名目录 | 直接使用 macOS 网络环境 |
| Linux | FUSE 3 + SSHFS | OpenSSH `ssh` | 当前工作区下的配置名目录 | 直接使用 Linux 网络环境 |
| WSL | `sshfs-bridge` | `ssh-bridge` | 当前工作区下的配置名目录 | 可通过 Windows TCP 中继访问外部 VPN |

默认配置文件：

- Windows、macOS、Linux：`~/serverless-remote-ssh/config.json`
- WSL：`~/.wsl-vpn-ssh/config.json`

WSL 继续与
[`wsl-vpn-ssh-bridge`](https://github.com/SupremeJulyan/wsl-vpn-ssh-bridge)
共用配置。也可以通过 `serverlessRemote.configPath` 为当前平台指定其他文件。

## 环境要求

- Windows：OpenSSH Client、
  [WinFsp](https://github.com/winfsp/winfsp/releases/latest) 和
  [SSHFS-Win](https://github.com/winfsp/sshfs-win/releases/latest)
- macOS：OpenSSH、
  [macFUSE](https://macfuse.github.io/) 和
  [SSHFS](https://github.com/macfuse/macfuse/wiki/File-Systems-%E2%80%90-SSHFS)
- Linux：OpenSSH、SSHFS、FUSE 3 和 `mountpoint`
- WSL：`mountpoint`、[`ssh-bridge`](https://github.com/SupremeJulyan/wsl-vpn-ssh-bridge)
  和 [`sshfs-bridge`](https://github.com/SupremeJulyan/wsl-vpn-ssh-bridge)

`Serverless Remote SSH: Install Dependencies Tips` 会检查当前平台：

- Windows 和 macOS 显示缺失组件的官方下载入口。
- Linux 和 WSL 会读取 `/etc/os-release`，为 Debian/Ubuntu、Fedora/RHEL、
  Arch/Manjaro、openSUSE 或 Alpine 生成安装命令。
- WSL 缺少 bridge 时会提供从官方 GitHub 仓库安装的命令；安装时仅保留卸载
  脚本，并在扩展卸载时执行清理。
- 自动依赖检查会缓存已经通过的结果，手动执行命令始终重新检查。

## 快速开始

1. 安装本页对应版本的 VSIX。
2. 运行 `Serverless Remote SSH: Install Dependencies Tips` 并安装缺失组件。
3. 运行 `Serverless Remote SSH: Add SSH Config`。
4. 输入配置名称、`user@host`，然后选择密码或私钥认证。
5. 运行 `Serverless Remote SSH: Open Remote Folder`，或点击状态栏左下角的
   `Serverless SSH`。
6. 使用 `Serverless Remote SSH: Close` 关闭工作区并卸载远程目录。

添加配置向导会自动生成同名挂载。新配置默认挂载 SSH 登录目录（`.`）并自动
打开终端；WSL、Linux 和 macOS 默认在当前工作区下创建 `[配置名]` 目录，
Windows 默认使用 `R:`。WSL 还会询问是否启用 VPN 中继，使用 aTrust 等外部
Windows VPN 客户端时可选择启用。

## 命令

### Open Remote Folder

`Serverless Remote SSH: Open Remote Folder`

- 选择一个远程配置并解析固定或默认挂载路径。
- 创建本地目录，检查挂载状态，必要时执行 SSHFS 挂载并验证结果。
- 使用当前 VS Code 窗口打开挂载目录。
- 跨窗口重载保存并恢复操作状态，只在目标工作区准备好后打开终端。
- 如果工作区位于挂载根目录的子目录，会先恢复缺失的祖先挂载，再返回原工作区。
- 多个针对同一挂载的操作会按规范化路径串行执行，避免挂载、打开和卸载竞态。

### Open Remote Terminal

`Serverless Remote SSH: Open Remote Terminal`

- 每次手动执行都创建一个新的集成终端，不复用已有终端。
- 当前文件或工作区位于已配置挂载中时，自动选择最具体的匹配配置。
- 自动进入与本地当前位置对应的远程子目录。
- 不在挂载中时显示配置选择器。
- 如果直接打开的是空且已经断开的挂载目录，会先重新挂载。
- 终端名称为 `SSH: 配置名` 或 `SSH: 配置名 — 远程相对目录`。
- 连接进程异常退出时提示重新打开。

工作区启动、窗口恢复等自动流程仍会复用相同配置和远程目录的已有终端。这只
用于防止自动重复，不影响手动创建多个 SSH 会话。

### Close

`Serverless Remote SSH: Close`

- 选择要卸载的配置。
- 如果当前工作区正在使用该挂载，先关闭工作区，窗口重载后继续卸载。
- Linux 正常卸载遇到 `Device or resource busy` 时会回退到 lazy unmount；macOS
  遇到 `Resource busy` 时会自动改用 `diskutil unmount`。
- Linux 和 macOS 只在窗口关闭时自动清理本次插件会话创建的挂载，不会擅自
  卸载会话开始前已经存在的挂载。

### Show Status

`Serverless Remote SSH: Show Status`

在 `Serverless Remote SSH Status` 输出通道列出所有配置的挂载状态及本地路径。
WSL 还会显示已注册的 Windows TCP 中继、端口映射和进程状态。

### Open Config

`Serverless Remote SSH: Open Config`

打开 JSON 配置文件。文件不存在时创建包含 `hosts` 和 `mounts` 的最小模板。
插件附带 JSON Schema，可提供字段补全、校验、悬停说明和配置片段。配置缺失、
不可读或为空时，错误提示可直接跳转到配置文件。

### Add SSH Config

`Serverless Remote SSH: Add SSH Config`

- 输入唯一配置名和 `user@IP`、`user@域名` 或 IPv6 地址。
- 可输入密码并设置加密主口令，或留空后选择私钥路径。
- 密码与私钥认证只保留一种。
- 自动生成同名主机和挂载配置；同名配置存在时先确认是否覆盖。
- WSL 可额外设置 `vpn` 中继选项。

### Install Dependencies Tips

`Serverless Remote SSH: Install Dependencies Tips`

重新检查当前平台依赖并显示下载入口或可复制的安装命令。

## 配置

完整示例：

```json
{
  "encrypt_passwords": true,
  "hosts": [
    {
      "name": "dev",
      "ip": "10.0.0.2",
      "user": "alice",
      "port": 22,
      "vpn": true,
      "private_key_path": "~/.ssh/id_ed25519"
    }
  ],
  "mounts": [
    {
      "name": "dev",
      "host": "dev",
      "remote_path": "/srv/My Project",
      "local_path": "/通用挂载目录/My Project",
      "local_paths": {
        "windows": "R:",
        "macos": "/Users/alice/远程项目/My Project",
        "linux": "/home/alice/远程项目/My Project",
        "wsl": "/home/alice/远程项目/My Project"
      },
      "remote_terminal": "open"
    }
  ]
}
```

### `hosts`

- `name`：主机唯一名称，供 `mounts[].host` 引用。
- `ip`：服务器 IP 地址或域名。
- `user`：SSH 用户名。
- `port`：SSH 端口，默认 `22`。
- `vpn`：WSL 是否通过 Windows VPN 中继连接；其他平台直接使用本机网络。
- `private_key_path`：SSH 私钥路径。
- `password`：加密密码，使用私钥时无需设置。请勿把包含凭据的配置提交到版本库。

### `mounts`

- `name`：挂载和终端显示名称。
- `host`：对应 `hosts[].name`。
- `remote_path`：远程目录，`.` 表示 SSH 登录目录。
- `local_path`：没有平台专用值时使用的固定本地挂载路径。
- `local_paths`：`windows`、`macos`、`linux`、`wsl` 各平台的固定挂载路径；
  平台专用值优先于 `local_path`。
- `remote_terminal`：当前固定为 `open`。旧配置中的 `now`、`never` 等值会兼容
  读取并统一按 `open` 处理。

显式配置的 `local_path` 和 `local_paths` 始终视为固定位置，不会因为当前工作区
变化而重新计算。只有未配置本地路径时，WSL、Linux 和 macOS 才在当前工作区下
使用挂载名称创建默认目录。

## 认证与安全

- 向导创建的密码使用主口令加密为 `enc:v1:` 格式。
- 加密主口令存放在 VS Code SecretStorage 中，不写入 JSON 配置。
- 旧配置中的明文密码会在下次连接时要求设置主口令并自动迁移。
- macOS 和 Linux 使用权限受限、生命周期很短的 `SSH_ASKPASS` 文件传递密码，
  使用后立即删除。
- Windows 密码通过环境变量传给系统网络 API。
- WSL 将主口令安全传递给配套 bridge，由 bridge 解密和认证。
- 密码不会放入 SSH/SSHFS 命令参数或性能输出。
- OpenSSH 使用 `StrictHostKeyChecking=accept-new`：自动接受新主机，但拒绝
  已记录主机密钥发生变化的连接。
- 密码认证失败时会清除失效密码，并提供打开配置和定位密码字段的操作。
- 网络中断、认证失败和普通命令错误会分别识别，并保留底层命令的错误信息。

## 路径与工作区恢复

- 支持挂载根目录下任意层级的工作区，并保持本地、远程子目录对应关系。
- 多根工作区会按顺序查找匹配项；嵌套挂载优先选择路径最具体的配置。
- Windows 和 macOS 路径匹配不区分大小写。
- 路径通过独立进程参数传递；远程 Shell 目录经过安全引用，支持普通空格、中文、
  括号、方括号和单引号。
- 未挂载的 Windows 盘符以及只包含空工作区占位目录的挂载点都可以被识别并恢复。
- VS Code 切换文件夹、关闭文件夹和扩展主机重载期间，待处理操作会保存到全局
  状态并设置有效期；过期或配置已删除的状态会安全丢弃。
- 本地挂载客户端从用户主目录启动，避免窗口切换时临时空工作区导致 `cwd`
  校验失败。

## 性能与连接设置

### `serverlessRemote.reuseSshConnection`

默认值为 `true`。Linux、macOS 和 WSL 让 SSHFS 与远程终端通过 OpenSSH
ControlMaster 复用连接，减少重复握手。WSL 需要安装支持连接池的新版
`wsl-vpn-ssh-bridge`。Windows 当前由系统 SSHFS/SSH 实现各自管理连接。

### `serverlessRemote.sshfsCacheProfile`

Linux 和 macOS 可选：

- `fresh`：尽量关闭元数据缓存，优先看到外部远程修改。
- `balanced`：默认值，缓存文件和目录元数据数秒。
- `fast`：使用更长的元数据与内核缓存，速度更高；其他远程进程的修改可能延迟
  显示。

### `serverlessRemote.configPath`

覆盖当前平台的默认 JSON 配置文件位置，支持 `~` 展开。

### 性能输出

VS Code 的“输出”面板中，`Serverless Remote SSH` 通道使用 `[性能]` 前缀记录：

- 配置读取和依赖检查
- 挂载状态检查
- 密码凭据准备
- SSHFS 挂载与结果验证
- SSH 终端创建（不包含远端握手）
- 工作区变化和启动自动连接总耗时

四个平台使用同一种输出格式；实际出现的阶段取决于平台和当前连接流程。

## 安装

### 在 VS Code 中手动安装

1. 下载 `vscode-serverless-remote-ssh-0.8.15.vsix`。
2. 打开 VS Code 扩展视图（Windows/Linux：`Ctrl+Shift+X`；macOS：
   `Cmd+Shift+X`）。
3. 打开扩展视图右上角的 `...` 菜单，选择“从 VSIX 安装...”。
4. 选择下载的 VSIX；提示时重新加载窗口。
5. 运行 `Serverless Remote SSH: Install Dependencies Tips`。
6. 运行 `Serverless Remote SSH: Add SSH Config`，然后点击状态栏中的
   `Serverless SSH`。

升级时用新版 VSIX 重复安装即可，VS Code 会替换已有版本并保留配置。

### 使用命令行安装

```bash
code --install-extension vscode-serverless-remote-ssh-0.8.15.vsix
```

## 开发

```bash
npm install
npm test
npm run package
npm run vsix
```

生产构建由 TypeScript 类型检查和 esbuild 打包组成，VSIX 构建还会自动运行
预发布检查。

此扩展不在远程主机运行 VS Code 组件。必须在目标主机执行的构建、测试或其他
命令，应在远程 SSH 终端中运行。
