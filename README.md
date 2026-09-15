# dsh-desktop-shell

**把 DeepSeek Harness 的 WebUI 变成真正的桌面应用** —— 以 DSH 插件的形式，装完即用。

平时 DSH 的界面是浏览器里的一个标签页；装上这个插件后，它会自动在你的用户目录落地一个**便携启动器**
（已预编译，不需要你本机编译）、按当前运行环境生成配置，并在桌面 / 开始菜单创建快捷方式（登录自启默认关闭，需要时在设置里一键开启）。
双击桌面图标即可像普通程序一样启动，关掉窗口就最小化到托盘，托盘右键才真正退出。

> 本文档为完整中文说明（安装步骤、常见问题、原理）。英文文档在页面底部的折叠区。

---

## 目录

- [这个插件能带来什么](#这个插件能带来什么)
- [环境要求](#环境要求)
- [安装（三步）](#安装三步)
- [安装后自动创建了什么](#安装后自动创建了什么)
- [日常使用](#日常使用)
- [行为与安全说明](#行为与安全说明)
- [可复现构建与哈希（预编译 exe）](#可复现构建与哈希预编译-exe)
- [常见问题 FAQ](#常见问题-faq)
- [工作原理](#工作原理)
- [开发者](#开发者)
- [许可](#许可)

---

## 这个插件能带来什么

| 能力 | 说明 |
| --- | --- |
| 🪟 **独立窗口** | 自建 WebView2 窗口（与 Edge 同内核、无浏览器地址栏/标签页），标题为 *DeepSeek Harness* |
| 📌 **关闭即最小化到托盘** | 点窗口的 X 只是隐藏到系统托盘；**只有托盘右键「退出」**才会同时停止后端 |
| 🚀 **无痕启动** | 后端不弹任何控制台窗口；输出写入 `<home>\logs\dsh-web.log` |
| ⏳ **就绪门控** | 窗口不会提前跳转，必须等后端打印认证 URL（真正就绪）才进入界面 —— 不再闪一下 404 |
| 🚫 **不再另开标签页** | 自动追加 `--no-open`，后端不会再把地址交给默认浏览器 |
| 🐛 **调试模式** | 另一个快捷方式以**可见的 PowerShell 控制台**启动后端（输出同时写入日志），方便看报错 |
| 🤝 **自动接管** | 若检测到外部启动的 DSH 后端，一次点击即可重启并纳入启动器托管 |
| 🛡 **看门狗** | 后端意外退出会自动拉起；连续失败会退避，避免重启风暴 |
| 🛠 **设置内控制** | 设置 → 通用设置 新增「**DSH 桌面外壳**」行：安装/修复、重建快捷方式、登录自启开关、清理安装、重启后端、调试模式重启 |
| 🔒 **登录自启默认关闭** | 不会偷偷开机自启：只有你在设置里点击「开启登录自启」才会写入启动文件夹，随时可关 |
| 🧹 **一键清理** | 「清理安装」删除本插件创建的全部快捷方式与 `%USERPROFILE%\dsh-desktop` 目录（启动器运行时先提示你退出，避免误删） |
| 🧩 **零 Electron 依赖** | 复用系统自带 WebView2 运行时，npm 包仅 ~370KB、解包 1.2MB（Electron 方案约 200MB） |
| 📦 **免编译** | 随包分发已编译的 90KB `.exe`（.NET Framework 4.8 winexe），用户机器无需 VS/编译工具链 |
| 🔍 **源码随包** | `assets/DSHLauncher.cs`、`assets/build-icons.mjs` 一并提供，可审计、可自行重编译；`SHA256SUMS.txt` 固定随包二进制的哈希并由测试核对 |

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | **Windows 10 / 11（x64）** —— 启动器是 .NET Framework 4.8 WinForms 程序，暂不支持 macOS / Linux |
| WebView2 运行时 | 现代 Windows（Win11 及近期 Win10）通常**已预装**；若未装，从微软官网安装 Evergreen Runtime 即可。检测方法：看 `C:\Program Files (x86)\Microsoft\EdgeWebView\Application` 是否存在 |
| Node.js | **≥ 22**（DSH 自身的要求） |
| DSH | **≥ 0.1.5-rc.1**（Web profile）；启动器能自动在 npx 缓存或全局安装位置找到 `@deepseek-ai/dsh` |
| 权限 | 只需写自己的用户目录，**不需要管理员权限**；安装器不改动 DSH 本体 |

## 安装（三步）

### 第 1 步：把插件装进 DSH profile

**方式 A：从 npm 安装（推荐，需要包已发布到 npm）**

```powershell
dsh plugin --profile web add dsh-desktop-shell
```

**方式 B：直接从 GitHub 安装（仓库公开后可用，不需要 npm）**

```powershell
dsh plugin --profile web add github:RINGOLINK/dsh-desktop-shell
```

> 说明：这条路径依赖本机有 `git` 且能访问 GitHub。注意**插件管理器的「更新」按钮只服务 npm 直连来源**，
> 用 GitHub 源安装的插件需要更新时重新执行一次上面的命令（或改用方式 A）。

**方式 C：本地开发安装（源码方式）**

```powershell
git clone https://github.com/RINGOLINK/dsh-desktop-shell.git
dsh plugin --profile web add link:C:\path\to\dsh-desktop-shell
```

### 第 2 步：重启 DSH

插件由宿主在启动时加载，所以**必须重启一次 DSH**：

- 如果你已经在用启动器：托盘右键「**退出**」→ 双击桌面「**DeepSeek Harness**」；
- 如果还没用启动器：按你平时的启动方式关掉再启动即可。

### 第 3 步：刷新浏览器并确认

浏览器按 **Ctrl+F5** 强刷，然后检查四项：

1. **设置 → 通用设置** 里出现「**DSH 桌面外壳**」一行（显示是否已安装、快捷方式状态、登录自启状态、是否由启动器托管）；
2. **桌面**出现两个快捷方式：「DeepSeek Harness」「DeepSeek Harness (调试模式)」，**开始菜单**出现「DeepSeek Harness」；
3. 登录自启默认**关闭**（启动文件夹里没有 `deepseek harness.lnk`）——需要开机自启就在这一行点「开启登录自启」；
4. 安装目录 `%USERPROFILE%\dsh-desktop` 存在，里面有 `DSHLauncher.exe` 与 `SHA256SUMS.txt`。

还可以用接口自检（在本机浏览器或 PowerShell 里）：

```powershell
curl.exe http://127.0.0.1:3080/api/dsh-desktop/status
```

返回 JSON 中的 `status.installed` 为 `true`、`status.shortcuts` 四项都为 `true` 即安装完整。

## 安装后自动创建了什么

所有文件都集中在**一个目录**里（默认 `%USERPROFILE%\dsh-desktop`，可用 `DSH_DESKTOP_HOME` 环境变量改）：

```
DSHLauncher.exe                     启动器本体（预编译 x64，约 90KB）
Microsoft.Web.WebView2.*.dll        WebView2 托管 SDK
WebView2Loader.dll                  WebView2 原生加载器
DSHLauncher.ico / -debug.ico        黑白鲸鱼图标（主入口 / 调试入口）
DSHLauncher.cs, build-icons.mjs     上面程序的完整源码（可审计、可重编译）
SHA256SUMS.txt                      随包二进制（exe / DLL / ico）的 SHA-256 校验清单
launcher.config.json                按你当前环境生成（见下）
preferences.json                    你的选择（目前只有「登录自启」开关，默认关闭）
create-shortcuts.generated.ps1      实际执行过的快捷方式脚本
create-startup-shortcut.generated.ps1  开启登录自启时执行的最小脚本
logs\dsh-web.log, dsh-debug.log     后端输出（静默模式 / 调试模式）
launcher.state.json, command.json   启动器 ↔ 插件的控制通道
webview2-data\                      WebView2 配置目录（保存着 DSH 会话 Cookie；平时别删，「清理安装」会连同它一起删，重装后需重新登录）
```

**快捷方式**（都在用户目录里，卸载时可一键清理）：
桌面「DeepSeek Harness.lnk」、桌面「DeepSeek Harness (调试模式).lnk」、开始菜单「DeepSeek Harness.lnk」；
**登录自启（启动文件夹里的 `deepseek harness.lnk`）默认不创建**，需要你在设置里显式开启。
如果桌面上原本有自己建的 Edge PWA 快捷方式，它会被改名保留为「DeepSeek Harness (Edge 应用).lnk」，插件永远不会删除它。

`launcher.config.json` 字段说明：

| 字段 | 含义 |
| --- | --- |
| `port` | 后端监听的端口，安装时从**正在运行的宿主**读取（默认 3080） |
| `nodePath` | node.exe 路径（安装时取当前进程，读不到则自动探测） |
| `dshBin` | `@deepseek-ai/dsh/lib/bin.js` 路径（从当前进程命令行解析） |
| `dshArgs` | 启动参数，固定带 `--no-open`，阻止后端另开浏览器标签页 |
| `workingDir` | 后端工作目录（默认你的用户主目录） |
| `nodeOptions` | 继承你当前的 `NODE_OPTIONS`（例如 8GB 堆 + 崩溃堆快照） |
| `readinessTimeoutSeconds` | 等待"真正就绪"的兜底秒数（默认 45） |
| `baseDir` | 启动器自己的数据目录 |

**不是靠猜的**：配置里的端口、node、dsh 路径、内存参数全部由插件在安装时从**正在运行的宿主进程**读取，
所以复制出来的启动器启动的就是你平时用的那个后端。

## 日常使用

### 启动 / 关闭

- **启动**：双击桌面「DeepSeek Harness」→ 窗口出现并显示「正在启动 DSH 后端… 已等待 N 秒」→ 后端真正就绪后自动进入界面。
- **关闭窗口**：点 X **只是最小化到托盘**（会有气泡提示），后端继续运行。
- **恢复窗口**：双击托盘图标，或托盘右键「打开界面」。
- **彻底退出**：托盘右键「**退出**」——同时停止后端。

### 托盘菜单

| 菜单项 | 作用 |
| --- | --- |
| 打开界面 | 重新显示窗口 |
| 重启后端 | 重启 DSH 后端（窗口保持，不中断托盘） |
| 以调试模式重启 | 用可见控制台重启后端，便于观察报错 |
| 接管外部后端（重启） | 当后端是"外部启动"（非启动器托管）时，把它接管过来 |
| 打开日志 / 打开配置 / 打开数据目录 | 快速定位 `logs\dsh-web.log`、`launcher.config.json` 与安装目录 |
| 退出 | 停止后端并退出启动器 |

### 在设置里操作

设置 → 通用设置 →「DSH 桌面外壳」这一行提供：

- **安装 / 修复桌面外壳**：重新落地文件并按当前环境刷新配置（幂等，可随时点）；
- **重建快捷方式**：桌面 / 调试 / 开始菜单三项一起重建（登录自启按你的开关状态决定是否一起建）；
- **开启 / 关闭登录自启**：默认**关闭**；开启后才会在启动文件夹放 `deepseek harness.lnk`，关闭时立即删除它；
- **清理安装**：删除本插件创建的全部快捷方式 + 整个 `%USERPROFILE%\dsh-desktop` 目录（先退出托盘里的启动器，否则会提示你退出——避免删到正在使用的文件）；会一并删除 `webview2-data` 里保存的登录会话，重装后需重新登录。注意：**插件仍启用时，宿主下次启动会重新自动安装**——想让清理保持生效，请先卸载插件（或设置 `DSH_DESKTOP_NO_AUTOINSTALL=1`）；
- **重启后端** / **调试模式重启**：与托盘菜单等价，且**启动器在线时由启动器托管重启**，窗口不会关。

### 升级与卸载

- **升级插件**：`dsh plugin --profile web add dsh-desktop-shell@latest`（或插件管理器里的更新按钮）→ 重启 DSH。
  重启后宿主半区会再次自动落地，把你的启动器更新到新版本（正在运行的 exe 会用"改名换入"的方式安全替换）。
- **卸载**：

  ```powershell
  dsh plugin --profile web remove dsh-desktop-shell
  ```

  然后到 设置 → 通用设置 →「DSH 桌面外壳」点 **清理安装**（等价于手动删除 `%USERPROFILE%\dsh-desktop`
  目录与桌面 ×2、开始菜单快捷方式，以及开启过的登录自启快捷方式）。安装器**从不改动 DSH 本体**。
  插件卸载时**不会**自动删除你的文件——删除动作只在你点「清理安装」时发生（这是刻意的：宿主进程随时可能被启动器重启，自动删文件会误伤正在运行的启动器）。

## 行为与安全说明

收录前请先看这一节，它是这个插件对系统做的全部事情：

- **仅 Windows**：启动器是预编译的 x64 `.NET Framework 4.8` 可执行文件，依赖系统自带的 WebView2 Runtime；其他平台不会自动安装（宿主半区会跳过）。
- **写入位置**：只写 `%USERPROFILE%\dsh-desktop`（可用 `DSH_DESKTOP_HOME` 改），内含 `DSHLauncher.exe` 与 **WebView2 SDK 的 DLL**（`Microsoft.Web.WebView2.*.dll`、`WebView2Loader.dll`）、图标、启动器源码；不会写入 DSH 安装目录，也不改 DSH 本体。
- **快捷方式**：桌面两个（主入口 + 调试模式）、开始菜单一个；**登录自启默认关闭**，只有你在设置里开启后才会写入启动文件夹。已存在的 Edge PWA 快捷方式会被改名保留，绝不删除。
- **进程行为**：启动器会**托管**一个 DSH 后端进程（用你的 node + dsh bin 启动，继承你的 `NODE_OPTIONS`），关闭窗口只是隐藏，托盘「退出」才会停后端。
- **强制结束**：当没有启动器托管时，「重启后端」的回退路径会对**整个后端进程树**执行 `taskkill /PID <pid> /T /F`（强杀），随后按原参数重新拉起；此时正在进行的会话会被中断（与你自己重启 DSH 等价）。
- **网络行为**：插件只注册回环路由 `/api/dsh-desktop/*`（拒绝非 127.0.0.1 请求），不发起任何对外网络请求。
- **清理**：设置里的「清理安装」删除上面全部文件与快捷方式（含 `webview2-data` 里的登录会话）；不点它则什么都不会被删。但**插件还装着**时，宿主下次启动会自动把这些文件重新落地——要让清理保持，先卸载插件，或设 `DSH_DESKTOP_NO_AUTOINSTALL=1`。

## 可复现构建与哈希（预编译 exe）

`DSHLauncher.exe` 是预编译产物，随包提供完整源码 `assets/DSHLauncher.cs`，并用 SHA-256 清单固定二进制：

```powershell
# 校验随包二进制（与其他文件同一目录）
Get-Content .\SHA256SUMS.txt
Get-FileHash .\DSHLauncher.exe -Algorithm SHA256

# 从源码重建（Windows 自带 .NET Framework 编译器，无需 VS）
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe `
  /out:DSHLauncher.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll `
  /r:Microsoft.Web.WebView2.WinForms.dll /r:Microsoft.Web.WebView2.Core.dll `
  /r:WebView2Loader.dll DSHLauncher.cs

# 重新生成校验清单
node build-checksums.mjs
```

`SHA256SUMS.txt` 由 `assets/build-checksums.mjs` 生成，测试套件会逐条核对清单与随包文件的实际哈希，
所以清单不可能与实际发布的二进制脱节。

## 常见问题 FAQ

**Q1：双击快捷方式后一直卡在「正在启动 DSH 后端… 已等待 N 秒」？**
先看日志 `%USERPROFILE%\dsh-desktop\logs\dsh-web.log`（托盘菜单「打开日志」也可）。常见原因：
① `launcher.config.json` 里的 `nodePath` 或 `dshBin` 失效（例如你换了 Node 版本、或 DSH 换到了别处）——
点设置里的「安装 / 修复桌面外壳」重新按当前环境生成即可；
② 端口被别的程序占用；③ Node 版本过低。Debug 模式（托盘「以调试模式重启」）会把后端输出直接显示在控制台里。

**Q2：窗口里显示"需要认证 / 一片空白"？**
说明窗口没拿到后端的**进程令牌**。启动器只有自己托管后端时才能从它的输出里捕获令牌；
如果你之前是**外部启动**的 DSH，请用托盘「接管外部后端（重启）」（或设置行里的「重启后端」）把它接管过来。

**Q3：托盘图标是 Windows 默认图标，不是黑白鲸鱼？**
说明运行中的是**旧版启动器**。托盘右键「退出」→ 重新双击桌面快捷方式即可（新版会加载 `DSHLauncher.ico`）。
若桌面快捷方式图标也不对：在桌面按 F5；仍不对就执行一次设置里的「重建快捷方式」。

**Q4：启动时提示"检测到 DSH 已由外部进程启动"，要不要接管？**
要。外部实例的进程令牌只存在于那个进程里，启动器拿不到，因此无法在这个窗口里显示界面。
点「接管后端（重启）」会由启动器重新拉起后端（约 10 秒，会话数据不丢）。

**Q5：想换端口 / 换安装目录 / 改内存参数？**
编辑 `%USERPROFILE%\dsh-desktop\launcher.config.json`（托盘「打开配置」），改完重启启动器。
- 端口：`port`；安装目录：把整个目录搬到新位置后改 `baseDir`（或用环境变量 `DSH_DESKTOP_HOME` 指定）；
- 内存：`nodeOptions`（例如 `--max-old-space-size=8192 --heapsnapshot-near-heap-limit=2`）。

**Q6：关掉窗口后 DSH 还在运行吗？怎么确认？**
在运行。这是设计如此：X = 最小化到托盘，后端与托盘图标都还在。要彻底停止，用托盘右键「退出」。

**Q7：卸载后还有残留吗？**
插件会在 profile 里留一条依赖（按正常方式 `dsh plugin remove` 会自动清掉）；其余残留（`%USERPROFILE%\dsh-desktop`
目录 + 桌面 ×2 / 开始菜单 / 开启过的登录自启快捷方式）用设置里的「**清理安装**」一键删除，也可手动删。
插件卸载时**不会**自动删除文件（宿主随时可能被启动器重启，自动删会误伤正在运行的启动器）。
另外注意：只要插件还装着，宿主下次启动会在 1.5 秒后**自动重新安装**这些文件——想让清理结果保持生效，请先
`dsh plugin --profile web remove dsh-desktop-shell`（或设 `DSH_DESKTOP_NO_AUTOINSTALL=1`）再清理。DSH 本体（`%USERPROFILE%\.dsh`）不受影响。

**Q8：和我原来的 Edge PWA 快捷方式冲突吗？**
不冲突。安装时如果发现桌面已有指向 Edge 的「DeepSeek Harness」快捷方式，会把它**改名保留**为
「DeepSeek Harness (Edge 应用)」而不是覆盖；两者可以共存（Edge PWA 仍是浏览器窗口，没有托盘语义）。

**Q9：macOS / Linux 能用吗？**
暂时不能。启动器是 Windows 程序（WinForms + WebView2），且快捷方式是 Windows 的 `.lnk`。

**Q10：设置里的「DSH 桌面外壳」行不见了？**
① 确认插件还在：`dsh plugin --profile web add dsh-desktop-shell`（重复执行是安全的）；
② 插件需要**宿主重启**才会加载，重启后再 **Ctrl+F5**；
③ 打开浏览器控制台看是否有 `Failed to load plugins` —— 若报了某个 bundle 没注册，说明插件包名与客户端模块 id 不一致，请提 issue。

## 工作原理

1. **进程令牌门禁 + 就绪门控**：`dsh web` 给壳页面加了**每进程随机令牌**的访问门禁，启动时会打印
   `dsh web: http://127.0.0.1:<port>/?token=…`；访问该 URL 一次才会种下持久的签名 Cookie。
   启动器因此**自己托管后端**、从它的标准输出捕获这一行，再导航过去——这也解释了为什么"外部启动的实例"必须接管。
2. **为什么要等就绪**：`dsh web` 会先绑定端口、之后才挂载前端。若在"端口刚监听"时就导航，看到的就是前端未挂载的 404。
   启动器改为等真正的就绪信号（令牌行）或 HTTP 已有响应再导航一次。
3. **为什么不再开新标签页**：启动器自动给参数追加 `--no-open`，界面只在自己的窗口里刷新。
4. **图标为什么用 DIB 条目**：`.NET` 的 `Icon`/`NotifyIcon` **不能解码 PNG 压缩的 ICO 条目**（会渲染成噪声），
   所以随包 `.ico` 的 16/24/32/48/64 尺寸使用传统 DIB 条目，只有 128/256 用 PNG。

## 开发者

```powershell
node test/install.test.mjs     # 50 项：配置解析 / 安装 / 占用换入 / 快捷方式 / 登录自启 / 清理 / 重启助手 / 路由 / 校验清单 / 浏览器半区与行布局 / 包名与版本一致性
npm pack --dry-run             # 确认发布包内含 assets/
```

仓库结构：

```
lib/index.js     宿主半区：自动安装 + 4 条 loopback 路由（status/install/shortcuts/restart）
lib/install.js   安装器核心（可注入接缝、纯函数，便于单测）
lib/client.js    浏览器半区：设置 → 通用设置 的「DSH 桌面外壳」行
assets/          预编译启动器 + WebView2 依赖 + 图标 + C# 源码
test/            功能测试
.github/         CI（Windows + Node 22/24）与打 tag 自动发布 npm 的工作流
```

发布相关：渠道调研与检查清单见 [PUBLISHING.md](PUBLISHING.md)，GitHub 上传与在线安装见 [GITHUB.md](GITHUB.md)。

> 关于 `README.zh.md`：中文文档已并入本文件（默认首页），`README.zh.md` 仅作为历史链接的指引入口。

## 许可

MIT，见 [LICENSE](LICENSE)。

---

<details>
<summary><b>English documentation</b> (click to expand)</summary>

<br>

Turn the DeepSeek Harness Web UI into a **real desktop application** — from inside DSH, as a plugin.

Install the plugin, and it provisions a portable launcher next to your user profile, generates
its configuration from the live host, and creates the desktop / startup / start-menu shortcuts.
No separate installer, no Electron, no build step on the user's machine.

### What you get

| Feature | Details |
| --- | --- |
| **Own window** | A WebView2 window titled *DeepSeek Harness* — same Chromium engine as Edge, no browser chrome |
| **Close to tray** | The window's X hides it to the notification area instead of closing; only the tray menu *Exit* stops the backend |
| **Silent start** | The backend runs with no console window; stdout/stderr go to `<home>\logs\dsh-web.log` |
| **Readiness gating** | The window does not navigate until the backend prints its authenticated URL — no more flash of a 404 shell |
| **No stray tab** | `--no-open` is appended automatically, so `dsh web` never hands the URL to your default browser |
| **Debug mode** | A second shortcut starts the backend in a visible PowerShell console (output also tee'd to a log) |
| **Takeover** | If a DSH backend is already running outside the launcher, one tray action (or the settings row) restarts it under launcher management |
| **Watchdog** | An unexpectedly dead backend is restarted automatically, with backoff after repeated failures |
| **In-settings control** | A row in 设置 → 通用设置 (`DSH desktop shell`) with install/repair, rebuild-shortcuts, restart and debug-restart |

### Requirements

- **Windows 10/11** (the launcher is a .NET Framework 4.8 WinForms app; the payload is x64)
- **WebView2 Runtime** — preinstalled on current Windows; otherwise install the Evergreen Runtime
- **Node.js ≥ 22** and a DSH installation the launcher can find (`npx` cache or a global install)
- DSH `>= 0.1.5-rc.1`

### Install

```sh
# from npm (recommended)
dsh plugin --profile web add dsh-desktop-shell

# or straight from GitHub (once the repository is public)
dsh plugin --profile web add github:RINGOLINK/dsh-desktop-shell
```

Restart DSH (plugins load at host start), then open **设置 → 通用设置 → DSH 桌面外壳**.
The host half already provisioned everything on activation; the row lets you repair it,
rebuild shortcuts, or restart the backend. Then double-click **DeepSeek Harness** on the desktop.

### What the installer writes

Everything stays inside one directory (default `%USERPROFILE%\dsh-desktop`):

```
DSHLauncher.exe                     the launcher (prebuilt, x64)
Microsoft.Web.WebView2.*.dll        WebView2 managed SDK
WebView2Loader.dll                  WebView2 native loader
DSHLauncher.ico / -debug.ico        the whale icons (black & white)
DSHLauncher.cs, build-icons.mjs     full source of the above, for transparency/rebuilds
SHA256SUMS.txt                      SHA-256 manifest of the shipped binaries
launcher.config.json                generated from the live host (see below)
preferences.json                    your choices (today: the sign-in autostart switch)
create-shortcuts.generated.ps1      the shortcut helper that ran
create-startup-shortcut.generated.ps1  minimal helper used when autostart is enabled
logs\dsh-web.log, dsh-debug.log     backend output
launcher.state.json, command.json   launcher <-> plugin control channel
webview2-data\                      WebView2 profile (holds the DSH session cookie; kept day to day, deleted by "Remove installation" — you sign in again after a reinstall)
```

Shortcuts: desktop `DeepSeek Harness.lnk`, desktop `DeepSeek Harness (调试模式).lnk` and
start-menu `DeepSeek Harness.lnk`. **Sign-in autostart is off by default** and only creates
`deepseek harness.lnk` in the Startup folder when you enable it in the settings row. A
pre-existing Edge PWA shortcut is renamed to `DeepSeek Harness (Edge 应用).lnk` and is never
deleted by this plugin.

`launcher.config.json`:

```json
{
  "port": 3080,
  "nodePath": "C:\\Program Files\\nodejs\\node.exe",
  "dshBin": "…\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
  "dshArgs": "web --no-open",
  "workingDir": "C:\\Users\\you",
  "nodeOptions": "--max-old-space-size=8192 --heapsnapshot-near-heap-limit=2",
  "readinessTimeoutSeconds": 45,
  "baseDir": "C:\\Users\\you\\dsh-desktop"
}
```

Launcher flags: `--debug`, `--hidden`, `--takeover`, `--attach-only`, `--selftest`.
Environment overrides: `DSH_LAUNCHER_BASE` (alternate home, used by tests),
`DSH_LAUNCHER_NO_MUTEX=1` (allow a second instance), `DSH_DESKTOP_HOME`,
`DSH_DESKTOP_NO_AUTOINSTALL=1`.

### Behaviour & safety (what this plugin does to your machine)

- **Windows only**: the launcher is a prebuilt x64 .NET Framework 4.8 executable and needs the
  system WebView2 Runtime; on other platforms the host half skips auto-install entirely.
- **Writes**: only `%USERPROFILE%\dsh-desktop` (override with `DSH_DESKTOP_HOME`) — the launcher exe,
  the **WebView2 SDK DLLs** (`Microsoft.Web.WebView2.*.dll`, `WebView2Loader.dll`), the icons, the
  source and a `SHA256SUMS.txt` manifest. Nothing is written into the DSH installation.
- **Shortcuts**: two on the desktop (main + debug) and one in the start menu. **Sign-in autostart is
  off by default**; it writes into the Startup folder only after you enable it in the settings row.
  An Edge PWA shortcut you created yourself is renamed and preserved, never deleted.
- **Processes**: the launcher owns one DSH backend process (your node + dsh bin, inheriting your
  `NODE_OPTIONS`). Closing the window hides it; only the tray "exit" stops the backend.
- **Force kill**: when no launcher is managing the backend, the restart fallback runs
  `taskkill /PID <pid> /T /F` on the **whole backend process tree** and relaunches it with the
  original arguments — in-flight sessions are interrupted, exactly like restarting DSH yourself.
- **Network**: the plugin only registers loopback routes (`/api/dsh-desktop/*`, non-127.0.0.1 peers
  get 403) and makes no outbound requests.
- **Cleanup**: "Remove installation" in the settings row deletes every file above plus the shortcuts
  it created, including the saved WebView2 session (the next desktop launch signs in again); nothing
  is deleted unless you click it. While the plugin stays installed it re-provisions that folder on the
  next host start, so uninstall the plugin (or set `DSH_DESKTOP_NO_AUTOINSTALL=1`) when the removal
  has to stick.

### Reproducible build & hashes (prebuilt exe)

`DSHLauncher.exe` ships prebuilt together with its complete source (`assets/DSHLauncher.cs`) and a
SHA-256 manifest:

```powershell
# verify the shipped binaries
Get-Content .\SHA256SUMS.txt
Get-FileHash .\DSHLauncher.exe -Algorithm SHA256

# rebuild from source (the .NET Framework compiler shipped with Windows; no Visual Studio needed)
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe `
  /out:DSHLauncher.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll `
  /r:Microsoft.Web.WebView2.WinForms.dll /r:Microsoft.Web.WebView2.Core.dll `
  /r:WebView2Loader.dll DSHLauncher.cs

# regenerate the manifest
node build-checksums.mjs
```

`SHA256SUMS.txt` is produced by `assets/build-checksums.mjs`, and the test suite re-verifies every
line against the packaged bytes, so the manifest cannot drift from what is published.

### How it works (the two non-obvious parts)

1. **Authentication.** `dsh web` fences the shell behind a per-process token; it prints
   `dsh web: http://127.0.0.1:<port>/?token=…` at startup, and visiting that URL mints the durable
   signed session cookie. The launcher therefore *owns* the backend, captures that line from its
   stdout, and navigates there once. An already-running backend started elsewhere cannot be
   displayed (its token exists only in that process), which is why takeover exists.
2. **Icons.** `System.Drawing`/`NotifyIcon` cannot decode PNG-compressed ICO entries (they render as
   noise), so the small sizes in the shipped `.ico` files are classic DIB entries.

### Tests

```sh
node test/install.test.mjs     # 50 checks: config, install, lock-swap, shortcuts, autostart, cleanup, restart, routes, checksums, browser half + row layout, package/version identity
```

### Uninstall

```sh
dsh plugin --profile web remove dsh-desktop-shell
```

Then use **Remove installation** in 设置 → 通用设置 → DSH desktop shell (equivalent to deleting
`%USERPROFILE%\dsh-desktop` plus the desktop ×2, start-menu and — if you enabled it — Startup
shortcuts; it also drops the saved WebView2 session). Unloading the plugin never deletes anything by
itself: the DSH host can be started by the launcher at any moment, so automatic deletion would risk
removing files that are in use. Note that while the plugin stays installed it re-provisions the
folder on the next host start, so uninstall it (or set `DSH_DESKTOP_NO_AUTOINSTALL=1`) when the
removal has to stick.

### License

MIT — see [LICENSE](LICENSE).

</details>
