# Changelog

## 1.6.4

- SAFS MCP 改为按需使用：移除无意义的 `execution` 字段、全局强制调用和
  `alwaysLoad` 提示，普通本地工作区不再被自动探测或误判为远程。
- 使用职责单一的 `safs_list_remote_workspaces` 和 `safs_select_remote_workspace`：
  Agent 获取聚焦优先的紧凑列表，在自身界面询问用户后以 `host` 和 `workspaceRoot`
  完成绑定；重复“列出再选择”可切换。
- MCP 对外接口移除与 `host` 重复的 `mountName` 参数和返回字段。
- 每次选择返回独立短 `bindingId`，后续工具必须携带；窗口失效、Router 接管或绑定
  不匹配时明确要求重选，不再静默回退，多个同名 Agent 会话也不会互相覆盖。
- 普通文件写入继续限制在当前工作区；任意 Shell 中无法证明只读的命令必须确认，
  高风险命令在确认模式下需要输入目标主机确认短语。
- 更新 MCP SDK 传递依赖补丁，`npm audit` 生产依赖漏洞归零。

## 1.6.3

- 本地 watcher 改为同路径串行并保留尾沿事件，修复上传期间再次保存时最终版本
  可能被漏掉；停止同步后的排队事件也不会继续写入远端。
- 远程删除、重命名及增量基线删除增加缺失状态防回声，避免本地落地事件反向
  操作远端；远程重命名跨入或跨出同步根时会正确下载或删除本地内容。
- 本地非空目录删除改为递归删除远端子树，并正确处理本地文件/目录类型互换；
  远程文件根切换为空目录时会重建本地同步根。
- 每个同步任务独立管理 watcher，根类型变化时自动重建；目录任务同时监听同步根
  条目和内部子树，删除或重建整个本地同步目录不再漏同步。
- 下载覆盖前的本地改动检测增加大小、ctime 和文件类型校验，降低同 mtime 修改
  被远端内容覆盖的风险；远程扫描遇到已排队等待上传的本地路径时主动让行，
  避免扫描与保存并发时覆盖尚未上传的编辑。

## 1.6.2

- 目录树父节点固定打开配置的远程默认目录，不再记忆上次打开的子目录或重复写入
  历史；历史子节点继续用于打开、同步和管理具体目录。
- 修复远程新增文件下载到本地后，连续的文件监听事件可能把它再次上传到远程；
  下载指纹现在会覆盖完整事件簇，同时保留真实本地修改的即时上传。
- 同步任务由其他 VS Code 窗口持有时不再每秒重复输出正常的协调状态日志。
- SFTP 握手不再依赖特定网关 banner 文案或固定超时：逐字节验证并定位真正的
  `SSH_FXP_VERSION` 包，统一跳过中文、英文、星号分隔线及二进制前缀。
- 底部状态栏拆分显示：`SAFS SFTP` 入口与 SAFS SYNC 一样独立常驻，Agent 转发
  焦点提示改为单独一项，不再顶替 SFTP 文案；转发停止时仅隐藏焦点项。
- 状态栏入口跟随实际传输通道：服务器未提供 SFTP 子系统而回退 SCP/exec 时，
  入口显示为 `SAFS SCP`（悬停提示说明回退原因）；连接池状态变化即时刷新
  （含中断重连、空闲回收后的懒重连），恢复 SFTP 或断开后自动还原。
- 转发焦点文案精简：就绪时 `Agent 已聚焦当前窗口😏`，干活时直接显示来源
  （如 `codex（wsl）远程转发中💪`）；悬停提示说明路由关系，同步镜像窗口
  额外注明“改动与远程双向同步”。
- 跨平台修复（此前仅在 Linux 验证）：同步任务锁的存活检测把 Windows/多用户
  环境下的 EPERM 误判为进程已退出，可能抢走活锁导致双窗口并发同步，现仅
  ESRCH（进程不存在）才回收；远程重命名同步到本地改为先清除目标再改名
  （Windows 的 rename 不覆盖已存在文件），并按 dev+ino 识别大小写改名，
  避免误删唯一副本。

## 1.6.1

- 修复同步完成后历史条目仍可能打开 `agent-cwd` 远程工作区：同步就绪状态改为
  跨窗口共享，已启用同步的条目不再静默回退到远程目录。
- 同一同步任务增加跨 Extension Host 文件锁，避免多个 VS Code 窗口同时下载、
  监听和反向上传；本地 watcher 忽略 `.safs-part` 下载临时文件。
- 首次同步复用可视化下载体验：显示扫描、当前文件、文件数、累计字节和百分比，
  支持取消；并使用唯一临时文件名避免 Extension Host 重载时并发基线冲突。
- 修复同步本地工作区打开后没有自动远程终端：从本地同步任务映射回远程目录，
  按原 `remote_terminal: open` 设置自动连接，并保持远程 cwd 不变。
- `Terminal Follows Active File` 同时支持同步镜像中的 `file://` 文件：把本地相对
  路径映射回远程目录后，对远程终端执行对应的 `cd`。
- 同步镜像窗口现在完整保留远程上下文：终端重连、远程目录操作、Agent/MCP、
  相对路径命令和“当前远程文件”均会把本地工作区/文件映射回对应远程位置；同时
  持久化单文件同步类型，避免重载后错误扩大其本地匹配范围。

## 1.6.0

- 远程目录历史条目新增本地同步开关。确认并选择本地目标后，复用
  “SAFS：可视化同步”建立双向同步；同步期间“打开目录”改为打开本地镜像，
  远程终端仍连接原远程目录，底部状态栏显示 `SAFS SYNC`。关闭同步后恢复
  默认的远程目录打开行为。

## 1.5.7

- 新增 **SAFS: 为我的Agent安装转发功能** 命令：与"复制 Streamable HTTP URL"
  相同的 Agent 名与平台选择流程，但复制到剪贴板的是一段安装提示词；
  把提示词粘贴到 Agent 输入框，由 Agent 自行注册名为 `safs` 的
  Streamable HTTP MCP 服务器（用户级）。

## 1.5.6

- Agent 焦点底栏改为两阶段文案：尚未收到 MCP 调用时提示
  “当前窗口已作为Agent转发焦点，可以让它干活了 😏”；识别来源后显示
  如“当前窗口已作为Agent转发焦点，codex（wsl）正在干活 💪”。
- 修复 Agent 来源状态在 VS Code 失焦时被清除：Agent 在桌面版或终端
  发起请求后，切回远程窗口会正确恢复 `codex（wsl）` 等具体来源；
  只有转发停止或 MCP 不可用时才清除。
- Agent 焦点底栏改为独立 ID 的高优先级状态项，避免长文案因底栏
  空间不足被整项挤掉，并避免继承旧匿名 SAFS 项的隐藏偏好。
- 固定 MCP URL 支持 `agent` 来源标签：自动注册为每个 Agent 写入
  各自的带标签 URL，并附加 `platform=wsl|mac|linux|win`；
  路由输出和远程命令日志记录 Agent 名与平台。
- “SAFS：复制 Streamable HTTP URL”新增 Agent 名输入框，
  以及 wsl/mac/linux/win 平台选择，可为自动配置列表之外的
  Agent 生成带来源标签的 URL。
- 当前远程窗口收到带来源标签的 Agent MCP 请求后，
  VS Code 底部状态栏显示如“当前窗口已作为codex（wsl）转发焦点，
  可以让它干活了 😏”；
  窗口失去焦点或转发停止时恢复默认 SAFS 状态。
- MCP 工作区元数据字段由 `remoteRoot` 更名为 `workspaceRoot`，
  明确表示 VS Code 当前打开目录，而非读取权限边界。
- `remote_write` 的写入边界收紧到 `workspaceRoot` 及其子目录，
  并阻止通过符号链接越界；`remote_list`/`remote_search` 仍允许读取
  明确指定的其他绝对路径。

## 1.5.5

- MCP 工作区路由修正：`resolve_workspace_execution` 和
  `list_remote_folders` 现在返回 VS Code 当前实际打开的远程子目录，
  `remote_list`、`remote_search` 和 `run_remote_command` 的默认相对路径/
  工作目录也与之一致；配置的挂载根仅保留为写入和命令的
  安全边界，避免 Agent 从大型挂载根开始扫描。
- 窗口 MCP 将路径越界、高危命令拦截等业务错误作为结构化
  `REMOTE_TOOL_ERROR` 透传，不再被固定路由器误报为远程不可用。
- `remote_search` 新增 `matchCount`，无匹配时明确返回 `0`。

## 1.5.1

- **主机密钥校验对齐（默认 `safs.hostKeyChangedAction` 为 `prompt`）**：
  - **唯一信任记录 = 扩展独立的 known_hosts 文件**（`~/.safs/known_hosts`，
    0600，不碰用户真实文件）；
  - **首次连接与每次遇到新主机密钥（后端轮换 / 重装）都弹窗确认**：弹窗
    突出显示目标主机 IP:端口与登录用户，并展示旧/新密钥指纹；接受后写入
    文件，拒绝则中止连接（每次确认弹一个窗口，无附加密钥等多余选项）；
    文件里已有的密钥直接放行，不再询问；
  - 系统 ssh 路径（WSL/Linux/macOS/Windows 非内置通道）新增**连接前密钥校验**：
    扩展先用 ssh-keyscan（WSL 走 ssh-bridge probe，含 VPN 中继路径）探测当前
    后端密钥，与文件比对后决定放行 / 确认 / 拒绝，不再是无校验裸奔；
  - **OpenSSH 原生校验兜底**：系统 ssh 以 `StrictHostKeyChecking=yes` + 同一
    文件连接——即使扩展校验逻辑失效，文件里没有的密钥也会被 OpenSSH 拒绝
    （本地实测：删除文件后连接被拒）；
  - 内置 ssh2 通道（Windows 终端、SFTP）读取同一个文件做校验；
  - 目录与终端按 VS Code 自然顺序**串行**打开（先目录后终端）：同一时刻
    不会有两个校验并发触发，无需并发去重，同一主机一个确认弹窗；
  - `accept` 保持完全静默（known_hosts 空设备），`reject` 保持严格校验。
- 修复系统 ssh 路径二次连接失败：known_hosts 指向空设备避免密钥轮换触发
  OpenSSH "禁用密码认证"分支（continue_unsafe）+ LogLevel=ERROR 消除
  "Permanently added" 噪音。

## 1.5.0

- 合并 1.4.11~1.4.14 的关键修正：
  - 每主机 SCP 回退记忆与过期清理；
  - NSG 网关直连真实 SFTP 的 banner 容忍与回退改进；
  - SCP/SFTP 连接挂起、超时与并发回收；
  - 传输通道记忆移除、目录/文件大小写提速、Base64 写读通道优化，以及慢操作诊断。
- 1.5.0 作为统一发布版本，后续仅保留当前双平台/单包产物。

## 1.4.14

- **打开文件提速：读文件改走 exec + base64 通道**（与写入同一思路）。gsx 实测打开
  一行文件要 3 秒——慢的不是 SCP 协议理念，而是 `scp -f` 进程启动 + SCP 协议多次
  往返在网关上开销巨大，而 exec 通道（find/stat/mv）实测每条约 0.5s。读文件现在：
  - `ScpSession.readFile` 走 `base64 < 文件`（exec 通道，可靠且快），本地解码；
    空文件正确返回空 buffer；base64 缺失自动回退 legacy SCP；
  - 大下载（可视化下载/同步）仍走 `readFileStream`（scpRead 流式，带停滞看门狗）；
  - 编辑器打开文件从“stat(缓存命中) + scpRead”变为“stat(缓存命中) + base64 读取”，
    预期 gsx 上从 ~3s 降到 ~1s。
- **慢操作诊断**：provider 的 stat/readDirectory/readFile 单次超过 1.5s 时输出
  `[慢操作] <操作> <毫秒>` 到 SAFS Log 通道——如果还慢，日志直接告诉我们慢的是
  传输通道本身还是调用方（VS Code 资源管理器）发起的调用次数。

## 1.4.13

- **修复 SCP 回退写入永久挂起（gsx 实测“正在创建文件”卡 2 分多钟）**：部分网关上
  `scp -t` 通道（SCP 上传）收不到确认字节就永久等待，而此前 60s 超时只覆盖了 exec
  通道，没覆盖 scpRead/scpWrite——通道挂起 = 永久占用并发额度 = 所有操作排队。
  - **小文件（≤2MB）写入改走 exec + base64 通道**：与列举/stat/mv 同一条在 gsx 上
    验证可靠的通路（内容 base64 编码走 stdin，远端 `base64 -d` 落盘；显式 mode 时
    `umask 0 && … && chmod` 保证权限不受远端 umask 影响）。编辑器场景（新建/保存/
    小脚本）全覆盖；base64 不可用的非 GNU 环境自动回退 legacy SCP。
  - **scpRead/scpWrite 增加 60s 停滞看门狗**：无数据/无进度即销毁通道并断开连接
    （连接池下次操作重连自愈），不再永久挂起；大文件传输以 stdin drain 续命，
    不会误杀正常慢速传输。
  - 预期：gsx 上新建/保存小文件从“卡死”变为 ~1.5s 内完成（3 条 exec：写入 + stat +
    mv），且任何情况下最多 60s 报错而不是无限等待。

## 1.4.12

- **移除传输通道记忆**（1.4.11 引入后验证发现收益极小）：对比基线日志，
  gsx 的 2.7 秒耗时大头是 SSH 传输层握手（TCP + 密钥交换 + 认证，网关侧慢），
  SFTP 子系统探测只占其中零点几秒；记忆省掉的正是这部分，但被握手时间盖过。
  恢复为每次连接都正常探测（SFTP 主机探测即握手本身，无额外代价）。
- **SCP 回退进一步提速：realpath + 操作合并为单条 exec**。gsx 每条 exec 约 0.5s
  （固定开销：开 channel + 起 shell），此前挂载验证、首次列目录都是“先 realpath
  再操作”两条命令。新增 `SftpSession.statResolved` / `readDirectoryResolved`：
  - `ScpSession` 实现为单条 exec（`cd` + `pwd -P` 出规范路径 + `stat`/`find`）；
    `Ssh2SftpSession` 等价于原两步（SFTP 快，无需合并）；
  - `SftpFileSystemProvider.readDirectory` 改用 `readDirectoryResolved`，首次列目录
    从 2 条 exec 降为 1 条，并继续对返回的规范路径做符号链接越界校验；
  - 挂载验证（`ensureFolder`、`cachedRemoteDirectory`）改用 `statResolved`，
    从 2 条 exec 降为 1 条，`statResolved` 的 `cd` 语义天然保证“是目录”，
    非目录/非 GNU stat 自动退化为原有两步（报错语义不变）。
  - 预期：gsx 打开远程目录的“握手后”耗时（验证 + 根目录列举）从 ~2s 降到 ~1s。
- **打开远程文件提速：目录列举预填子项 stat 缓存**。列举本来就带每个子项的完整
  元数据（size/mtime/mode），此前只存了类型，编辑器/资源管理器对子项的 stat 还要
  单独走一次网络。现在非符号链接子项在列举后直接命中 statCache（30s TTL，随目录
  缓存同生命周期，写/删/重命名时同步失效）——打开文件从“stat + SCP 下载”两条
  通道操作降为**仅 SCP 下载一条**（gsx 上约 1s → 约 0.5s）；符号链接维持按需 stat，
  避免缓存类型与实际目标类型不一致。
- **写入文件提速（Ctrl+S，SCP 回退）**：此前保存要走 ~6 条 exec（临时文件 exists
  检查、权限探测、chmod、rename 内部的 pathExists+stat+mv）+ 1 个 SCP 通道，
  gsx 上约 3.5 秒。本次：
  - 临时文件写入改传显式 `mode`（`SftpWriteOptions.mode`）——跳过 exists/权限探测；
  - 新增 `SftpSession.replaceFile(source, target, mode)`：SCP 下 **chmod + mv -f
    合并为一条 exec**（SFTP 下等价 chmod + rename）；
  - 目录目标（罕见）仍走原 chmod + rename 流程，行为不变。
  - 预期：保存从 ~6 exec + 1 通道降为 **2 exec + 1 通道 ≈ 1.5s**。
  - 子目录展开此前已是 1 条 exec（合并列举命令），本次无需改动。

## 1.4.11

- **每主机 SCP 回退记忆（跳过重复的 SFTP 子系统探测）**：同一网关（如 gsx）每次
  连接都要被拒 SFTP 子系统（约 3s 等待），本版把探测结果记入 globalState。
  **只记忆 SCP**——SFTP 主机的正常连接没有可省的步骤（子系统请求即握手本身），
  不写入记忆：
  - key=主机名，同时记录当时的 IP——配置里 IP 变更即失效重新探测；
  - 记忆 24 小时后过期重探（网关侧若日后开放 SFTP 能自动升级通道）；
  - 记过的主机下次连接**直接走 SCP**，不再尝试 SFTP 子系统（`connectSftp` 新增
    `skipSftpProbe` 参数）；实际连接为 SFTP 时自动清除残留的过期 scp 记忆；
  - 输出通道日志标注 `（记忆命中 scp）` / `（新探测）`，SFTP 主机无标注。

## 1.4.10

- **NSG 网关直连真 SFTP（不再回退 exec/SCP）**：网关在每个 SSH channel 开头注入的
  MOTD banner（`\r \r … 一\r\n`）会污染 SFTP 子系统通道的首个数据包（长度字段变成
  ASCII 文本），ssh2 报 `Packet length … exceeds max length` 后整体失败，插件被迫
  回退 exec/SCP（网关上每条 exec 秒级，目录加载极慢）。本次在**打包时**把同样的
  容忍逻辑注入 ssh2 的 SFTP 版本握手
  （`build/sftp-banner-patch.js`，经 esbuild onLoad 插件生效）：
  - 版本握手阶段先暂存流入数据，采用**两阶段剥离**：阶段 1 在缓冲区内任意位置找
    `\r \r` 签名（允许前导空行）并扫描 `一\r\n` 终止符后开始解析；阶段 2 无签名时
    逐字节跳过首个“合法 SFTP 包长度”之前的前缀（文本字节不可能构成合法长度，
    误判时类型校验失败仍回退，不会卡死）；探测上限 256KB，banner 可跨 chunk；
  - 无 banner 的服务器行为完全不变（单测覆盖单块/逐字节/边界/前导换行/二进制前缀/
    异常垃圾等 8 个场景）；
  - 失败仍走原有报错 → SCP 回退，不会卡死；
  - 回退判定加宽（`Expected VERSION packet`/`Unknown packet type`/`Malformed
    VERSION` 等 banner 污染的其他错误形态也触发回退），并在输出通道记录回退原因、
    实际传输通道（`[SFTP] xxx 传输通道：sftp/scp`）以及**通道首 64 字节 hex**
    （诊断网关 banner 实际格式用）。
- **修复 SCP 回退下“一直加载中”的永久挂起**：NSG 网关偶发命令永久挂起（半开连接/
  网络挂载卡死），此前 exec 无超时，挂起的命令会永久占用并发 channel 额度——
  并行轮询下几条挂起命令即可耗尽全部 5 个额度，之后所有操作永久排队。本次：
  - `ScpSession` 每条 exec 增加 **60s 超时**：超时后销毁 channel、断开连接
    （释放并发额度），连接池在下次操作时自动重连自愈，不再永久卡死；
  - SFTP 通道的控制类操作（realpath/stat/readdir/rename/mkdir/rmdir/unlink/
    chmod）同样增加 **60s 超时**（ssh2 的 SFTP 请求本身无超时，防止请求石沉大海）；
    文件内容传输（readFile/writeFile/流式读写）不受影响，大文件不会被误杀。
- **SCP 回退大幅提速**（NSG 网关无 SFTP 子系统时）：
  - `ScpSession.realpath` 增加 60s 缓存：同一路径在窗口期内复用规范路径，不再重复
    `readlink -f`；
  - `ScpSession.readDirectory` 把 realpath + 列举压成**一条 exec**（`cd` + `pwd -P`
    输出 `P\t<规范路径>` 行，再 `find`/`ls` 列举），命令数减半；空目录也直接返回
    `[]`（旧实现会多跑一次 ls 回退）；
  - 列举后顺带把**非符号链接子项的规范路径**一并缓存（符号链接仍按需解析以防越界），
    资源管理器随后对子项的 stat 不再产生任何 exec；
  - `SftpFileSystemProvider.pollWatches` 改为**并行轮询**（并发由会话自身 channel
    信号量约束），单次慢操作不再拖住全部 watch 项；
  - `safs.sftp.cacheTtl` 默认值 5s → **30s**：轮询周期内的 stat/目录命中缓存，
    不再每 5 秒穿透到网络（远程变更检测延迟随之变为最多 ~30s，可按需调回）。

## 1.4.9

- **移除 MCP 工具 `remote_read` 与 `read_current_remote_file`，远程文件内容不再返回
  Agent 上下文**：Agent 只需通过 `current_remote_file` 拿到当前打开文件的路径与元数据，
  需要查看内容时用 `run_remote_command` 在远程执行 `head`/`sed`/`grep`/`tail`/`wc`/
  `diff` 等命令按需查看，避免大文件内容被整段拉进模型上下文造成巨额 token 消耗。
  VS Code 内置 Agent 工具 `#safsRead`、`#safsReadCurrentRemoteFile` 同步移除；
  `resolve_workspace_execution` 的 `fileTools` 与 MCP instructions 已更新，并新增
  "文件内容永不返回会话" 的指令引导。
- **移除冗余 MCP 工具 `current_remote_workspace` 并去掉 `list_remote_folders` 的
  强制加载**：`current_remote_workspace` 返回的数据与 `resolve_workspace_execution`
  完全重复，删除以减少工具定义与调用开销；`list_remote_folders` 不再标记
  `alwaysLoad`，避免每轮请求都常驻其完整定义。精简了 MCP 工具描述以降低基础提示词
  体积。
- **为 Agent 工具结果加上 token 限流与瘦身**：
  - `run_remote_command` 的 stdout+stderr 默认上限从 1 MiB 降至 64 KB（新设置
    `safs.agentMcpMaxOutputBytes` 可调，范围 4 KB–1 MiB），超限截断并返回
    `truncated: true`，单次 `head`/`cat`/`grep` 不再可能把几十万 token 灌进会话；
  - `remote_list` 新增 `limit` 入参，默认最多返回 500 条条目，超限返回
    `truncated: true` 与 `total`，`node_modules` 等巨型目录不再刷屏；
  - `remote_search` 结果收窄为最多 200 行、每行 300 字符，并跳过
    `node_modules`、`dist`、`build`、`.venv`、`__pycache__` 等依赖/构建/缓存目录
    （按目录名在任意层级匹配），minified 文件命中也不会撑爆上下文；
  - 工具结果统一改为紧凑 JSON（去掉缩进空白，MCP 与 VS Code 内置 Agent 工具均生效），
    结构化结果普遍节省 15–30% token；
  - `run_remote_command` 结果不再回显 `command`（Agent 自己刚发过，回显等于重复
    计费）；`current_remote_file` 去掉与 `path` 重复的 `uri`、`fileName` 字段；
  - `resolve_workspace_execution`/`list_remote_folders` 的 workspace 元数据瘦身为
    `mountName`/`remoteRoot`/`host`（窗口级）或含 `execution`/`focused`（路由器级），
    删除与 `mountName` 重复的 `name` 与已无用途的 `workspaceUri`。

## 1.4.8

- **修复 Windows 下 Agent CLI 报 `spawn codex ENOENT`（npm 全局安装的
  codex/claude shim）**：`where.exe` 能解析出 npm 全局安装的 `*.cmd`/`*.bat`
  shim，但 Node 的 `spawn` 不能直接执行 `.cmd`/`.bat`（抛 ENOENT）。
  `resolveExecutable` 在 Windows 上改为经 `where.exe` 解析真实路径，
  `.cmd`/`.bat` shim 统一经 `cmd.exe /d /s /c` 执行（参数按 cmd 规则引用），
  `ssh.exe`、`wsl.exe` 等真实可执行文件仍直接 spawn，找不到命令时仍保留
  ENOENT 语义。pi/dsh 走文件式 MCP 注册、不涉及 CLI spawn，不受影响。
  新增 `process.ts` 单元/回归测试（`windowsCommandInvocation`、
  `executeCaptured` 执行 `codex --version`）。

## 1.4.7

- **Agent 转发新增"当前打开的远程文件"感知**：Agent 现在能知道并直接读取 VS Code
  当前打开的远程文件。新增 MCP 工具 `current_remote_file`（返回当前打开文件的
  绝对路径、相对挂载根路径、文件名、大小与是否有未保存修改）与
  `read_current_remote_file`（直接读取当前打开文件内容；编辑器有未保存修改时
  优先返回缓冲区内容 `source: "editor"`，否则经 SFTP 读取 `source: "sftp"`，
  支持 offset/length 字节分片，单次上限 1 MiB）。窗口级 MCP 与固定 HTTP 路由器
  均已注册，路由器按焦点窗口转发；无活动远程文件时返回 `null`。VS Code 内置
  Agent 同步新增 `#safsCurrentRemoteFile`、`#safsReadCurrentRemoteFile` 工具。
  `resolve_workspace_execution` 的 `fileTools` 与 MCP instructions 已同步更新。

## 1.4.6

- 修复 `safs.agentPlatform=wsl` 模式下 pi/dsh 注册失败：扩展宿主（VS Code 内置
  Node 20.x）对 `\\wsl.localhost\...` UNC 路径有主机白名单检查，直接 fs 读写抛
  `UNC host 'wsl.localhost' access is not allowed`。pi 的 settings.json/mcp.json
  与 dsh 的 cordis.patch.yml 读写改为**经 `wsl.exe -d <发行版>` 在 Linux 侧完成**
  （读取走 `cat`，写入走 `mkdir -p` + base64 解码 + `chmod 600/700`），新增
  `src/wsl-file.ts` 桥接模块与测试；非 UNC 路径行为不变。
- 修复 WSL 内 Agent CLI 检测不到：nvm 等只在交互 shell 生效的 PATH 配置
  （如 codex 装在 nvm 的 node 版本 bin 目录）对 `sh -lc` 不可见。WSL 内
  CLI 检测与执行改为**预设 PS1 后加载 `.profile`/`.bashrc` 的 bash**
  （`wslBashInvocation`），nvm 安装的 codex/pi 等可正常检测与执行。
- **插件本身装在 WSL 里时，`safs.agentPlatform=wsl` 与 `auto` 等效**：
  `resolveAgentPlatform` 增加插件平台检测（`detectPlatform()`），插件运行在
  WSL 内时无论设置值如何都直接使用本地家目录、不做 `wsl.exe` 间接解析
  （WSL 的 Linux 文件系统无法访问 wsl.exe 返回的 UNC 路径）。"Agent 平台"
  日志改按实际 `wsl` 标志显示。
- **WSL 内安装的 codex/claude VS Code 扩展可被检测**：`agentPlatform=wsl`
  时若 CLI 不在 WSL PATH，再扫描 `~/.vscode-server/extensions/<extId>-*`
  查找内置 CLI（Windows 端 getExtension 看不到 WSL 里安装的扩展），返回
  Linux 路径经 wsl.exe 执行；`bundledCandidates` 恢复 platform 参数
  （WSL 场景传 `linux`）。目录遍历/存在性检查经 wsl.exe 完成（绕开 UNC
  限制），并修复 dash 内置 `test` 不支持 `--` 的问题。

## 1.4.5

- 新增 **SAFS：可视化下载** 命令（远程文件/目录右键菜单）：大文件**流式下载**
  （边下边写、进度条、可取消），目录递归下载（按总字节推进进度、显示当前
  文件）；取消时当前文件半成品自动清理，目录场景已完成的文件保留。
- **SAFS：可视化同步（原"同步…"）下载流式化**：远程→本地的下载（首次基线、
  增量同步、实时写回）改为 `readFileStream` 流式落盘，GB 级文件不再整文件
  读进扩展宿主内存；下载期间本地被修改/删除的检测与回滚语义保持不变。
- SFTP 会话新增 `readFileStream` 流式读取原语；新增共享流式写盘模块
  `src/stream-file.ts`（可视化下载与同步共用，含测试）。
- 新增 **SAFS：可视化上传** 命令：本地文件/文件夹 → 远程（**本地文件/文件夹
  右键菜单即可见，无需打开远程目录**）。两步选择目标：先选远程挂载，再输入
  远程目录（Tab 补全）；流式上传 + 进度条 + 可取消，目录递归上传。SFTP 会话
  新增 `writeFileStream` 流式写入原语与共享 `pipeStreams` 管道助手。
- 修复可视化下载/上传进度显示：进度上报由"每 1MB / 跨整数百分比"改为**时间
  节流（约 150ms）+ 按字节占比推进**，传输一开始即显示文件名、已传/总量与
  百分比，小文件与慢速网络下也能持续刷新。
- **修复可视化上传目录路径错误**：上传本地目录（如 `VPN/xx.exe`）时目录名
  丢失、文件被当成目录（`xx.exe/xx.exe`）。上传规划抽为可单测的
  `src/upload-plan.ts`：目录名进入远程路径（`targetDir/VPN/xx.exe`）、空目录
  一并创建，文件不再重复拼接 basename。
- **修复大文件上传卡在开头**：ssh2 `createWriteStream` 在大文件/网关下存在
  写位置与背压缺陷（首个块后不再排空，进度停在几百字节）。`writeFileStream`
  改为**句柄式分块写**（`open → 逐块 write(显式偏移) → close`，写回调驱动
  背压，每块 60s 超时防挂起），与整写 `writeFile` 同一底层语义；新增假
  sftp 单测（偏移推进/打开失败/写错误/中止清理）。
- 修复上传/下载进度中的文件名显示：上传显示相对目标目录的路径（含源目录名，
  如 `AF3/af3.bin.zst`），下载目录显示"根目录名 + 相对路径"，同名文件不再
  分不清。
- 恢复 `safs.agentPlatform` 设置（**Agent 工作位置**：`auto` | `wsl`，默认
  `auto`）：`wsl` 模式下 MCP 注册读写 WSL 家目录下的配置文件
  （`~/.pi/agent/mcp.json`、`$DSH_HOME/cordis.patch.yml`），Agent CLI 通过
  `wsl.exe` 在 WSL 内检测与执行；恢复 `src/agent-platform.ts` 与对应测试。

## 1.4.3

### 安全加固

- **主机密钥校验三路径统一**：SFTP 文件系统路径接入与终端一致的 TOFU 主机
  密钥校验（此前完全无校验）；系统 ssh 路径（macOS/Linux/WSL/Windows 系统
  ssh）不再无条件 `StrictHostKeyChecking=no`，改由 `safs.hostKeyChangedAction`
  驱动（`accept`→`no` / `prompt`→`accept-new` / `reject`→`yes`），默认值
  保持 `accept`（负载均衡 VIP 场景静默接受变化）。
- MCP 路由器转发信任边界：禁止 3xx 重定向跳出 loopback、拒绝转发到路由器
  自身端口、带 `x-safs-forwarded` 标记的请求一律拒绝（防路由器间环）、发现
  记录时间戳双向校验（未来时间不再永不过期）。
- 高危命令拦截补防：`$(...)`/反引号/`sh -c`/`eval` 内嵌内容解包后递归分析，
  补重定向截断（`> /etc/...`、`> /dev/sda` 等）、`tee`/`truncate`、
  `fsck`/`tune2fs` 规则。
- 敏感文件权限统一 0600/0700（初始配置文件、pi MCP 配置、dsh patch 等）；
  `encrypt_passwords` 缺省按 `true` 处理。
- 主口令处理：单个主机密文损坏不再误删全局主口令；交互式终端环境不再注入
  `WSL_VPN_MASTER_PASSWORD`；新增统一脱敏（`src/redact.ts`），命令日志与
  输出通道隐藏 Bearer 令牌、URL token、`--api-key`、`KEY=value` 等。

### 稳定性与性能

- 远程同步引擎重构：本地→远程 per-path 串行队列 + 尾沿合并（不再丢事件）、
  下载覆盖前检测本地改动（不再覆盖下载期间的用户编辑）、file↔dir 类型互换
  先删后建、rename 目标越界校验、本地 watcher 引用计数共享、基线失败指数
  退避重试。指纹引擎抽为可单测的 `src/sync-diff.ts`。
- 命令级超时：新设置 `safs.agentMcpTimeoutMs`（默认 120000ms，0 关闭），
  远程命令/搜索超时后中止执行，Agent 挂起时不再留下后台孤儿命令。
- Windows 远程命令复用 ssh2 连接（会话池），消除每条命令重新握手；私钥
  每连接读取一次。
- SFTP 连接池空闲回收（`safs.sftp.idleConnectionTtl`，默认 600s）；重连前
  关闭旧会话以释放 WSL 中继租约。
- SFTP 连接级错误自动恢复：单个操作遇到 `ECONNRESET`/`EPIPE` 等连接级错误时，
  自动使池中会话失效、重连并在新连接上重试一次（瞬时远端重置不再直接报错，
  如"无法创建 Agent cwd 占位目录：read ECONNRESET"）；`closeIdle` 回收前复核
  空闲状态，消除判断-关闭竞态。
- `remote_read`（MCP）按字节范围读取，不再整文件下载后切片。
- 激活提速：WSL 依赖安装后台执行不阻塞窗口；工作区恢复逐挂载容错；心跳
  错误日志去重；`reuseSshConnection` 缺省语义统一。
- 打开远程目录提速：Agent 转发探测结果缓存 60s + 探测并行 + 单项 15s 超时
  （不再每次打开都串行 spawn 全部 Agent CLI）；重复子目录校验复用内存缓存
  （减少 realpath/stat 往返）；终端打开时 OpenSSH 能力探测与凭据准备并行。
- 修复 dsh MCP 注册被静默丢弃：`cordis.patch.yml` 是补丁方言，新增行必须用
  `- insert:` 包裹；此前写入顶层 `- id: mcp-safs` 只会按 id 覆盖已有行（目标
  不存在时警告后跳过），导致 dsh 从未加载 SAFS MCP。现在生成正确的
  `- insert:` 块，并兼容旧格式的定位与替换。

## 1.4.2

- Remove the `safs.agentPlatform` setting and the WSL agent-platform feature
  introduced in 1.3.8: Agents always run on the extension's own platform — MCP
  config files are read/written under the extension-process home
  (`os.homedir()`), and Agent CLIs are detected on the local `PATH` or inside
  the installed VS Code extension. Anyone who set `safs.agentPlatform=wsl`
  now gets the default local behaviour; the setting can be removed from their
  configuration.

## 1.4.1

- Withdraw the WSL platform support introduced in 1.3.9 (reverted): the
  extension no longer special-cases running inside a WSL window, and on
  Windows with `safs.agentPlatform=wsl` it no longer scans the WSL VS Code
  Server extensions directory for a bundled Agent CLI. Agent CLI detection is
  back to the 1.3.8 behaviour (`wsl.exe` checking the WSL PATH).

## 1.4.0

- New setting `safs.hostKeyChangedAction` (`prompt` | `reject` | `accept`,
  default `accept`): controls what happens when a remote SSH host key changes
  (e.g. load-balanced VIPs where each backend has its own key). `prompt` shows
  the old and new fingerprints and lets you accept the new key and continue
  instead of hard-failing; `reject` keeps the previous
  strict behaviour; `accept` silently accepts and updates the stored key.
- WSL/Linux/macOS system-OpenSSH terminals and command execution now use
  `StrictHostKeyChecking=no` instead of `accept-new`, so a
  changed host key on a load-balanced VIP no longer aborts the connection.

## 1.3.10

- Sync progress shows in the bottom-center status bar: "正在同步…" on
  start, "远程(保存/删除/重命名/建目录) → 本地" on remote changes, and
  "本地(新建/修改/删除) → 远程" on local changes.
- Status-bar item renamed to **SAFS SFTP**.
- Fix local-change status not appearing in the window where the local sync
  directory is open: the sync manager's session lookup now works from any
  window (falls back to resolving the mount from config), so the local
  watcher starts and shows its status there too, and the sync keeps running
  as long as any window is open.

## 1.3.8

- New setting `safs.agentPlatform` (`auto` | `wsl`, default `auto`): lets the
  Agents run in a different platform than the extension. With `wsl`, MCP
  registration reads/writes the Agents' config files under the WSL home
  (resolved via `wsl.exe wslpath -w "$HOME"`, e.g. `~/.pi/agent/mcp.json` and
  `~/.dsh/cordis.patch.yml`), and Agent CLIs (`codex`/`claude`) are detected
  and executed through `wsl.exe` inside WSL instead of the extension-process
  PATH.

## 1.3.7

- `safs.agentForwardingAgents` now defaults to `codex`, `claude`, `pi`, and
  `dsh`. `dsh` (DeepSeek Harness) is handled by a built-in file-based handler:
  SAFS writes an `@deepseek-ai/dsh-mcp-client` plugin entry into
  `$DSH_HOME/cordis.patch.yml` (default `~/.dsh/cordis.patch.yml`), which DSH
  hot-applies via its config HMR watch without a restart. Removing the
  forwarding entry cleans the patch back to its empty-root form while keeping
  user entries intact.
- Handler operation logs now use the Agent's own CLI name instead of the
  hardcoded `pi-mcp` prefix.

## 1.3.6

- New context-menu action on remote files/directories: **SAFS: 同步到本地…**.
  Two-way, event-driven sync (no polling): saving/creating/deleting/renaming
  a remote file through VS Code immediately mirrors it to the local
  directory, and changes made on the local side are uploaded back to the
  remote (via a local file watcher with loop guards). Tasks survive window
  reloads (incremental baseline via persisted fingerprints); use the same
  action again to stop the sync.
- Command renamed to **同步…** (no prefix); the sync-directory picker always
  opens at the user's home directory.

## 1.3.5

- Opening a remote terminal (command, auto-connect or after reopening a
  window) now always follows the currently open remote file's directory,
  regardless of `safs.terminalFollowsActiveFile`. The setting (default
  `false`) now only controls the live sync: when `true`, switching/opening a
  remote file also real-time `cd`s the terminal into that file's directory.

## 1.3.4

- `safs.terminalFollowsActiveFile` defaults back to `false`. The restore
  behavior is now unconditional: reopening a remote window restores the
  previous file tab and the auto-connected terminal follows that file's
  directory even with the setting off (one-shot, no blocking wait). With the
  setting `true`, every terminal open and every remote-file switch also
  syncs the terminal to the file's directory.
- Fix the intermittent restore-follow: the one-shot "restored file" flag was
  consumed by the first file-activation event even when the auto-connected
  terminal did not exist yet (file tab restored before the terminal was
  created), so the terminal sometimes stayed on the workspace root. The flag
  is now consumed only when a terminal is actually moved; a non-blocking
  deferred check (1.5s) covers the file-before-terminal timing window, and
  opening the terminal directly at the file's directory clears the flag.
- Fix the remaining intermittent case: when the restored file tab activates
  before the SSH shell channel is ready, the `cd` sent by live-sync was
  dropped. The built-in ssh2 terminal now queues input until the shell
  channel is open and then delivers it, so the terminal reliably lands in
  the file's directory.

## 1.3.3

- New setting `safs.terminalFollowsActiveFile` (default `true`): when a
  remote terminal opens, it automatically enters the directory of the
  currently open remote file. With it enabled, reopening a remote window
  restores the previous file tab and the terminal follows that file's
  directory (up to 2s wait for the editor restore) instead of the workspace
  root.
- Live sync: with the same setting enabled, every time the active editor
  switches to a remote file, the mount's remote terminals automatically
  `cd` into that file's directory (only when the directory changes). This
  also covers window restore — the terminal opens immediately and moves to
  the restored file's directory once its tab becomes active (no wait).

## 1.3.2

- Activity-bar icon: replaced the generic remote glyph with a clean bold
  "SAFS" letters-only logo.

## 1.3.1

- Rename `SAFS: 切换远程目录` to `SAFS: 打开远程目录`: choosing a directory
  now opens it in a **new window** and keeps the current window open (each
  window keeps its own directory and Agent-forwarding/MCP binding), instead
  of replacing the current window.

## 1.3.0

- Config entries in the explorer are no longer click-to-connect (prevents
  accidental connections); open them via the context menu or the command
  palette instead.
- Connection and Agent-forwarding states now show as ✓/✗ in the tree
  (details remain in the tooltip).
- Enabling Agent forwarding shows a bottom-right progress notification while
  the MCP servers are being registered on first use.
- Suppress OpenSSH 10+'s post-quantum KEX warning on legacy servers: an
  explicit capability-filtered `KexAlgorithms` list (PQ first, then modern,
  then legacy group exchange) is passed on the system `ssh` path and the WSL
  bridge, so `** WARNING: connection is not using a post-quantum key
  exchange algorithm **` no longer spams the terminal.

## 1.2.8

- Hide the `cd -- '…'` line printed when a remote terminal opens on Windows
  (built-in ssh2 terminal): the working directory is now applied as part of
  the remote command (`cd -- '…' && exec "${SHELL:-/bin/sh}" -l`) with a pty
  — the same mechanism the system `ssh` paths use — instead of typing the cd
  into the interactive shell. The `--` option terminator is kept so paths
  starting with `-` still work. Verified interactive shells on gknzy/gsxzy/
  yxzy gateways (no cd echo, cwd correct, prompts working).

## 1.2.7

- Code review cleanup:
  - Remove unused `defaultAgentMcpPort` export.
  - Remove unused `stripGatewayMotd` export (the incremental `MotdStripper`
    covers streaming channels).
  - Add `transport = 'sftp'` to `Ssh2SftpSession` for parity with the SCP
    session.
  - Unify the SFTP-unusable / retryable-handshake patterns in `client.ts`
    and drop the unreachable `throw lastError` after the retry loop.

## 1.2.6

- Fix `Packet length … exceeds max length` on NSG gateways that inject a MOTD
  banner into every SSH channel (e.g. 10.68.0.101: `
 
 … 一×17 …
  |核数:128 …`). The banner corrupts the SFTP version handshake and SCP
  headers, so the extension now (1) falls back to the exec/SCP session for
  this error class too, and (2) strips the gateway MOTD prefix (detected by
  its `
 
` signature, cut at the box-bottom line) from exec, SCP-read and
  SCP-write streams. Verified end-to-end on the real gateway: remote folder,
  listing, read/write all work.
- Remove the 1.2.5 raw-bytes sniffer: attaching a data listener to ssh2's
  socket corrupted packet parsing and reproduced the very error it was meant
  to diagnose.

## 1.2.5

- Handshake-failure diagnostics: when a gateway responds with invalid SSH
  data ("Packet length … exceeds max length"), the error now includes the
  first bytes the server actually sent (hex), making it possible to identify
  the responding device/route (e.g. a captive portal or VPN route to the
  wrong host) instead of guessing from the generic packet-length message.

## 1.2.4

- Fix WSL terminals failing to open with `EACCES` when the packaged
  `ssh-bridge` lost its executable bit. VSIX archives built on Windows (and
  checkouts without the git exec bit) store the script with mode 0666, so
  spawning it as the terminal shell failed even though the remote folder
  (SFTP, which never uses the bridge) still opened. The extension now
  re-asserts mode 0755 on `ssh-bridge` at activation.
- Retry SSH handshakes when an NSG/gateway injects garbage during the first
  connection ("Packet length … exceeds max length of 262144"): `connectSftp`
  now retries with fresh connections (up to 3 attempts, VPN relay kept)
  before failing, and the error dialog explains that the server returned
  invalid SSH handshake data.

## 1.2.3

- WSL robustness: the bundled ssh-bridge no longer hard-requires `flock`
  (minimal WSL distros ship without util-linux), and the VPN relay pool
  falls back to a `mkdir`-based lock and a hand-built `\\wsl$\<distro>\...`
  path when `flock`/`wslpath` are missing. Fixes terminals failing to open
  with exit code 1 ("缺少命令 'flock'") on stripped-down WSL distros.
- Fix Agent MCP registration spawning the bare CLI name instead of the
  resolved binary: `run_agent_mcp_operation` now runs the resolved command
  (PATH lookup or the VS Code extension's bundled CLI), so Claude Code with
  only the extension-installed binary works (previously `spawn claude
  ENOENT`).

## 1.2.2

- Reconnecting a closed remote terminal now `cd`s into the remote directory
  currently open in the window (kept in sync by SAFS: 切换远程目录) instead
  of the cwd the terminal was originally opened with.

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
  connection — reusing the authenticated ssh2 connection. The remote
  folder, file tree, read/write/search and Agent MCP tools all keep working
  over the legacy SCP protocol plus shell commands (find/stat/mv/mkdir/rm).
  Verified end-to-end against a real sftp-less gateway.

## 1.1.6

- New setting `safs.sshClientIdent` (default `OpenSSH_9.6`): the client
  identification sent after `SSH-2.0-` on all ssh2 connections (SFTP,
  built-in terminal, remote commands). Some NSG/gateway appliances whitelist
  well-known SSH clients (OpenSSH, PuTTY…) and reject unusual ones
  like `ssh2js`, producing `Unable to start subsystem: sftp` / `Unable to
  request a pseudo-terminal` even though the server supports SFTP. If the
  default is still rejected, try `PuTTY_Release_0.78`.

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
