# dsh-desktop-shell

**把 DeepSeek Harness 的 WebUI 变成真正的桌面应用** —— 以 DSH 插件的形式，装完即用。

平时 DSH 的界面是浏览器里的一个标签页；装上这个插件后，它会自动在你的用户目录落地一个**便携启动器**
（已预编译，不需要你本机编译）、按当前运行环境生成配置，并在桌面 / 启动文件夹 / 开始菜单创建快捷方式。
双击桌面图标即可像普通程序一样启动，关掉窗口就最小化到托盘，托盘右键才真正退出。

> 本文档为完整中文说明（安装步骤、常见问题、原理）。英文文档在页面底部的折叠区。

---

## 目录

- [这个插件能带来什么](#这个插件能带来什么)
- [环境要求](#环境要求)
- [安装（三步）](#安装三步)
- [安装后自动创建了什么](#安装后自动创建了什么)
- [日常使用](#日常使用)
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
| 🛠 **设置内控制** | 设置 → 通用设置 新增「**DSH 桌面外壳**」行：安装/修复、重建快捷方式、重启后端、调试模式重启 |
| 🧩 **零 Electron 依赖** | 复用系统自带 WebView2 运行时，npm 包仅 ~367KB、解包 1.2MB（Electron 方案约 200MB） |
| 📦 **免编译** | 随包分发已编译的 90KB `.exe`（.NET Framework 4.8 winexe），用户机器无需 VS/编译工具链 |
| 🔍 **源码随包** | `assets/DSHLauncher.cs`、`assets/build-icons.mjs` 一并提供，可审计、可自行重编译 |

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

1. **设置 → 通用设置** 里出现「**DSH 桌面外壳**」一行（显示是否已安装、快捷方式状态、是否由启动器托管）；
2. **桌面**出现两个快捷方式：「DeepSeek Harness」「DeepSeek Harness (调试模式)」；
3. **启动文件夹**出现 `deepseek harness.lnk`（登录后自动启动），**开始菜单**出现「DeepSeek Harness」；
4. 安装目录 `%USERPROFILE%\dsh-desktop` 存在，里面有 `DSHLauncher.exe`。

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
launcher.config.json                按你当前环境生成（见下）
create-shortcuts.generated.ps1      实际执行过的快捷方式脚本
logs\dsh-web.log, dsh-debug.log     后端输出（静默模式 / 调试模式）
launcher.state.json, command.json   启动器 ↔ 插件的控制通道
webview2-data\                      WebView2 配置目录（保存着 DSH 会话 Cookie，别删）
```

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
- **重建快捷方式**：桌面 / 启动 / 开始菜单四项一起重建；
- **重启后端** / **调试模式重启**：与托盘菜单等价，且**启动器在线时由启动器托管重启**，窗口不会关。

### 升级与卸载

- **升级插件**：`dsh plugin --profile web add dsh-desktop-shell@latest`（或插件管理器里的更新按钮）→ 重启 DSH。
  重启后宿主半区会再次自动落地，把你的启动器更新到新版本（正在运行的 exe 会用"改名换入"的方式安全替换）。
- **卸载**：

  ```powershell
  dsh plugin --profile web remove dsh-desktop-shell
  ```

  然后删除 `%USERPROFILE%\dsh-desktop` 目录，以及四个快捷方式（桌面 ×2、启动文件夹、开始菜单）。
  安装器**从不改动 DSH 本体**。

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
插件会在 profile 里留一条依赖（按正常方式 `dsh plugin remove` 会自动清掉）；其余就是 `%USERPROFILE%\dsh-desktop`
目录与四个快捷方式，手动删除即可。DSH 本体（`%USERPROFILE%\.dsh`）不受影响。

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
node test/install.test.mjs     # 27 项：配置解析 / 安装 / 占用换入 / 快捷方式 / 重启助手 / 路由 / 包名一致性
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
launcher.config.json                generated from the live host (see below)
create-shortcuts.generated.ps1      the shortcut helper that ran
logs\dsh-web.log, dsh-debug.log     backend output
launcher.state.json, command.json   launcher <-> plugin control channel
webview2-data\                      WebView2 profile (holds the DSH session cookie)
```

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
node test/install.test.mjs     # 27 checks: config, install, lock-swap, shortcuts, restart, routes, package identity
```

### Uninstall

```sh
dsh plugin --profile web remove dsh-desktop-shell
```

Then delete `%USERPROFILE%\dsh-desktop` and the four shortcuts (desktop ×2, Startup, start menu).
The installer never touches the DSH installation itself.

### License

MIT — see [LICENSE](LICENSE).

</details>
