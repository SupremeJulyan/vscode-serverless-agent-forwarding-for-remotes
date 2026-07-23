# Serverless Remote SSH

[简体中文](README.md) | [English](README_EN.md)

通过 SSHFS 在 VS Code 中编辑远程文件，并使用真正的 SSH 终端，无需在目标主机上安装 VS Code Server。

插件会根据当前系统选择相应的平台适配器，并将每个远程目录挂载为操作系统中的真实目录。WSL 使用 `sshfs-bridge` 和 `ssh-bridge` 管理 VPN 中继；原生 Windows、macOS 和 Linux 则直接使用所在操作系统的 VPN 和网络环境连接。

## 环境要求

- Windows：[WinFsp](https://github.com/winfsp/winfsp/releases/latest) 和 [SSHFS-Win](https://github.com/winfsp/sshfs-win/releases/latest)；默认挂载到 `R:` 盘
- macOS：[macFUSE](https://macfuse.github.io/) 和 [SSHFS](https://github.com/macfuse/macfuse/wiki/File-Systems-%E2%80%90-SSHFS)，以及 OpenSSH
- Linux：SSHFS、FUSE 3 和 OpenSSH
- WSL：`ssh-bridge`、`sshfs-bridge` 和 `mountpoint`
- 原生 Windows、macOS 和 Linux 默认配置文件：`~/serverless-remote-ssh/config.json`
- WSL 默认配置文件：`~/.wsl-vpn-ssh/config.json`，继续与 `ssh-bridge` 和 `sshfs-bridge` 共用

在 Windows 上必须安装 OpenSSH Client、[WinFsp](https://github.com/winfsp/winfsp/releases/latest) 和 [SSHFS-Win](https://github.com/winfsp/sshfs-win/releases/latest)。运行 `Serverless Remote SSH: Install Dependencies Tips` 可以检查缺失项并显示对应的下载入口。

在 macOS 上，如果缺少依赖，插件会提供 [macFUSE](https://macfuse.github.io/) 和 [SSHFS](https://github.com/macfuse/macfuse/wiki/File-Systems-%E2%80%90-SSHFS) 的官方下载入口。

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
      "name": "dev",
      "host": "dev",
      "remote_path": ".",
      "local_path": "/当前目录/dev",
      "remote_terminal": "open"
    }
  ]
}
```

## 命令

- `Serverless Remote SSH: Open Remote Folder`：挂载选中的远程目录，使用 VS Code 打开对应的本地 SSHFS 目录，并在该目录中打开远程终端。
- `Serverless Remote SSH: Open Remote Terminal`：在 VS Code 集成终端中建立 SSH 连接；WSL 平台使用 `ssh-bridge`。如果工作区或活动文件位于已配置的挂载目录中，插件会直接匹配对应配置并进入远程子目录；该路径映射同时支持 WSL 和原生 Windows、macOS、Linux。
- 插件管理的远程终端因连接进程结束而退出时，会提示使用 `Serverless Remote SSH: Open Remote Terminal` 重新打开。
- `Serverless Remote SSH: Close`：关闭正在使用的远程目录并卸载对应 SSHFS。
- `Serverless Remote SSH: Show Status`：在输出面板中显示所有挂载状态；WSL 还会显示 SSHFS/SSH 中继状态。
- `Serverless Remote SSH: Open Config`：打开共用的 JSON 配置文件。
- `Serverless Remote SSH: Add SSH Config`：依次输入配置名、`user@IP` 和密码；输入密码后还需设置并确认配置加密主口令，密码留空时则改为输入私钥路径。密码与私钥只保存一种，并自动生成同名挂载配置。WSL 会额外询问是否使用 VPN 中继，默认为 `false`；使用 aTrust 等外部 VPN 时选择 `true`。
- `Serverless Remote SSH: Install Dependencies Tips`：检查当前平台所需软件，提示缺少的软件包或可复制的安装命令。

新配置固定挂载 SSH 登录目录，并固定使用 `open` 终端方式。WSL、Linux 和 macOS 默认在当前工作区下创建 `[配置名]` 目录，Windows 默认使用 `R:` 盘。执行 `Open Remote Folder` 后，插件会依次完成挂载、切换到挂载目录，并在新窗口恢复后只创建一个 SSH 终端。已有同名终端会直接复用。

新向导输入的 SSH 密码会使用加密主口令保存为 `enc:v1:` 密文。旧配置中的明文密码会在下次连接时要求设置主口令并自动迁移为密文。macOS 和 Linux 通过短生命周期的 `SSH_ASKPASS` 辅助程序将解密后的密码提供给 OpenSSH 和 SSHFS；密码不会出现在命令参数或任务输出中。

旧配置中的自定义 `remote_path`、`local_path` 和 `local_paths` 仍然兼容；`now`、`never` 等旧终端方式会统一按 `open` 处理。

`vpn: true` 表示使用 VPN 可访问的网络路径。在 WSL 上，桥接程序会启动并共享 Windows TCP 中继。在原生 Windows、macOS 和 Linux 上不需要额外中继，因为 SSHFS 与该平台的 VPN 客户端位于同一个网络环境中。macOS 和 Linux 的配置向导不会显示中继选项，状态输出中也不会包含中继部分。

在 Linux 和 macOS 上，由当前 VS Code 插件会话创建的挂载会在该 VS Code 窗口关闭时自动卸载。插件不会卸载本次会话开始前已经存在的挂载。

## 安装

### 在 VS Code 中手动安装

1. 将 `.vsix` 安装包下载到本地。
2. 打开 VS Code，选择活动栏中的**扩展**图标，或者按 `Ctrl+Shift+X`；macOS 使用 `Cmd+Shift+X`。
3. 选择扩展视图右上角的**视图和更多操作...**（`...`）菜单。
4. 选择**从 VSIX 安装...**。
5. 选择 `vscode-serverless-remote-ssh-0.8.5.vsix` 并确认安装。
6. 如果 VS Code 提示重新加载窗口，选择**立即重新加载**。
7. 安装完成后，会提示安装必要软件包：1）WSL、Linux 环境复制安装指令；2）macOS 需要安装 [macFUSE](https://macfuse.github.io/) 和 [SSHFS](https://github.com/macfuse/macfuse/wiki/File-Systems-%E2%80%90-SSHFS)，提示中提供对应下载按钮；3）Windows 系统需要安装 [SSHFS-Win](https://github.com/winfsp/sshfs-win/releases/latest) 和 [WinFsp](https://github.com/winfsp/winfsp/releases/latest)，提示中提供对应下载按钮。
8. `Ctrl+Shift+P`打开命令面板输入 `Serverless Remote SSH: Add SSH Config` 命令，开始添加配置，配置完毕后点击状态栏左下角中的 `Serverless SSH`，或者打开命令面板输入 `Serverless Remote SSH: Open Remote Folder`。
9. 关闭挂载连接使用 `Serverless Remote SSH: Close`。

升级已有版本时，使用新的 VSIX 安装包重复上述步骤即可，VS Code 会替换已经安装的版本。

### 使用命令行安装

```bash
code --install-extension vscode-serverless-remote-ssh-0.8.5.vsix
```

## 开发

```bash
npm install
npm test
npm run package
npm run vsix
```

此插件将语言服务和扩展保留在本地运行。必须在目标主机上执行的命令，应通过 SSH 终端运行。
