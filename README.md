# Serverless Remote SSH

[简体中文](README.md) | [English](README_EN.md)

通过 SSHFS 在 VS Code 中编辑远程文件，并使用真正的 SSH 终端，无需在目标主机上安装 VS Code Server。

插件会根据当前系统选择相应的平台适配器，并将每个远程目录挂载为操作系统中的真实目录。WSL 使用 `sshfs-bridge` 和 `ssh-bridge` 管理 VPN 中继；原生 Windows、macOS 和 Linux 则直接使用所在操作系统的 VPN 和网络环境连接。

## 环境要求

- Windows：WinFsp 和 SSHFS-Win；`local_path` 必须是 `X:` 这样的盘符
- macOS：macFUSE SSHFS 和 OpenSSH
- Linux：SSHFS、FUSE 3 和 OpenSSH
- WSL：`ssh-bridge`、`sshfs-bridge` 和 `mountpoint`
- 所有平台共用配置文件：`~/.wsl-vpn-ssh/config.json`

在 Windows 上，如果缺少 WinFsp 或 SSHFS-Win，插件会先请求确认，然后下载锁定版本的官方 MSI 安装程序、校验 SHA-256，并启动需要管理员权限的安装过程。拒绝安装后，插件会记住当前安装程序版本；如需重试，可运行 `Serverless Remote SSH: Install Windows Dependencies`。

在 macOS 上，如果缺少依赖，插件会提供 macFUSE SSHFS 官方安装说明的入口。

在 Linux 和 WSL 上，插件会读取 `/etc/os-release`，并针对 Debian/Ubuntu、Fedora/RHEL、Arch/Manjaro、openSUSE 或 Alpine 提供可复制的安装命令。WSL 缺少桥接命令时，该命令也会从官方 GitHub 仓库安装桥接程序。

配置示例：

```json
{
  "encrypt_passwords": true,
  "hosts": [
    {
      "name": "dev",
      "ip": "10.0.0.2",
      "user": "alice",
      "port": 22,
      "vpn": true
    }
  ],
  "mounts": [
    {
      "name": "project",
      "host": "dev",
      "remote_path": "/home/alice/project",
      "local_path": "/home/alice/mnt/project",
      "local_paths": {
        "windows": "X:",
        "macos": "/Users/alice/mnt/project",
        "linux": "/home/alice/mnt/project",
        "wsl": "/home/alice/mnt/project"
      },
      "remote_terminal": "open"
    }
  ]
}
```

## 命令

- `Serverless Remote SSH: Open Remote Folder`：挂载选中的远程目录，使用 VS Code 打开对应的本地 SSHFS 目录，并在该目录中打开远程终端。
- `Serverless Remote SSH: Open Remote Terminal`：在 VS Code 集成终端中建立 SSH 连接；WSL 平台使用 `ssh-bridge`。如果工作区或活动文件位于已配置的挂载目录中，插件会直接匹配对应配置并进入远程子目录；该路径映射同时支持 WSL 和原生 Windows、macOS、Linux。
- `Serverless Remote SSH: Mount` 和 `Unmount`：挂载或卸载选中的 SSHFS 配置。
- `Serverless Remote SSH: Show Status`：在输出面板中显示所有挂载状态；WSL 还会显示 SSHFS/SSH 中继状态。
- `Serverless Remote SSH: Open Config`：打开共用的 JSON 配置文件。
- `Serverless Remote SSH: Add SSH Config`：通过交互式输入添加 SSH 主机配置。
- `Serverless Remote SSH: Add SSHFS Config`：通过交互式输入添加挂载配置，包括引用的 SSH 主机和终端模式。

通过 `Add SSH Config` 输入的密码会先加密为与桥接程序兼容的 `enc:v1:` 格式，再写入配置文件。加密主口令保存在 VS Code SecretStorage 中。Windows 和 macOS 会在首次使用已有明文密码时自动完成加密迁移。macOS 通过短生命周期的 `SSH_ASKPASS` 辅助程序将解密后的密码提供给 OpenSSH 和 SSHFS；密码不会出现在命令参数或任务输出中。

当 `remote_terminal` 为 `now` 时，插件会在挂载时要求选择本地目录。其他模式优先使用当前平台对应的 `local_paths`，没有配置时回退到 `local_path`。Windows 应配置盘符，而不是 POSIX 路径。

`vpn: true` 表示使用 VPN 可访问的网络路径。在 WSL 上，桥接程序会启动并共享 Windows TCP 中继。在原生 Windows、macOS 和 Linux 上不需要额外中继，因为 SSHFS 与该平台的 VPN 客户端位于同一个网络环境中。macOS 和 Linux 的配置向导不会显示中继选项，状态输出中也不会包含中继部分。

在 Linux 和 macOS 上，由当前 VS Code 插件会话创建的挂载会在该 VS Code 窗口关闭时自动卸载。插件不会卸载本次会话开始前已经存在的挂载。

## 安装

### 在 VS Code 中手动安装

1. 将 `.vsix` 安装包下载到本地。
2. 打开 VS Code，选择活动栏中的**扩展**图标，或者按 `Ctrl+Shift+X`；macOS 使用 `Cmd+Shift+X`。
3. 选择扩展视图右上角的**视图和更多操作...**（`...`）菜单。
4. 选择**从 VSIX 安装...**。
5. 选择 `vscode-serverless-remote-ssh-0.7.7.vsix` 并确认安装。
6. 如果 VS Code 提示重新加载窗口，选择**立即重新加载**。
7. 安装完成后，使用状态栏中的 `$(remote) Serverless SSH`，或者打开命令面板并运行 `Serverless Remote SSH` 命令。

升级已有版本时，使用新的 VSIX 安装包重复上述步骤即可，VS Code 会替换已经安装的版本。

### 使用命令行安装

```bash
code --install-extension vscode-serverless-remote-ssh-0.7.7.vsix
```

## 开发

```bash
npm install
npm test
npm run package
npm run vsix
```

此插件将语言服务和扩展保留在本地运行。必须在目标主机上执行的命令，应通过 SSH 终端运行。
