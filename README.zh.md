# dsh-desktop-shell

把 DeepSeek Harness 的 WebUI **从插件层面爆改成桌面应用**。

安装这个插件，它会自动在你的用户目录落地一个可移植启动器、按当前运行环境生成配置，
并在桌面 / 启动文件夹 / 开始菜单创建快捷方式——不需要单独安装程序、不用 Electron、
也不需要在用户机器上编译。

> English: [README.md](README.md)

## 能力

| 能力 | 说明 |
| --- | --- |
| **独立窗口** | 自建 WebView2 窗口（与 Edge 同内核，无浏览器地址栏/标签页） |
| **关闭即最小化** | 点 X 只是隐藏到托盘；只有托盘右键「退出」才同时停止后端 |
| **无痕启动** | 后端不弹任何控制台窗口，输出写入 `<home>\logs\dsh-web.log` |
| **就绪门控** | 必须等后端打印认证 URL（真正就绪）才导航，不再看到前端未挂载的 404 |
| **不再另开标签页** | 自动追加 `--no-open`，后端不会再把地址交给默认浏览器 |
| **调试模式** | 第二个快捷方式以可见 PowerShell 控制台启动后端（输出同时 tee 到日志） |
| **自动接管** | 若检测到外部启动的 DSH 后端，一次点击即可重启并纳入启动器托管 |
| **看门狗** | 后端意外退出会自动拉起；连续失败会退避，避免重启风暴 |
| **设置内控制** | 设置 → 通用设置 新增「DSH 桌面外壳」行：安装/修复、重建快捷方式、重启后端、调试模式重启 |

## 环境要求

- **Windows 10/11**（启动器是 .NET Framework 4.8 WinForms，载荷为 x64）
- **WebView2 运行时**（现代 Windows 已预装；否则装 Evergreen Runtime）
- **Node.js ≥ 22**，且启动器能定位到 DSH 安装（npx 缓存或全局安装）
- DSH `>= 0.1.5-rc.1`

## 安装

```sh
dsh plugin --profile web add dsh-desktop-shell
```

重启 DSH（插件在宿主启动时加载），然后打开 **设置 → 通用设置 → DSH 桌面外壳**：
激活时宿主半区已经自动完成落地，这一行用于修复、重建快捷方式或重启后端。
之后双击桌面「DeepSeek Harness」即可。

## 安装器写了什么

全部集中在一个目录（默认 `%USERPROFILE%\dsh-desktop`）：

```
DSHLauncher.exe                     启动器（预编译 x64）
Microsoft.Web.WebView2.*.dll        WebView2 托管 SDK
WebView2Loader.dll                  WebView2 原生加载器
DSHLauncher.ico / -debug.ico        黑白鲸鱼图标（主 / 调试）
DSHLauncher.cs, build-icons.mjs     上述程序的完整源码（便于审计与重编译）
launcher.config.json                按当前运行环境生成（见下）
create-shortcuts.generated.ps1      实际执行过的快捷方式脚本
logs\dsh-web.log, dsh-debug.log     后端输出
launcher.state.json, command.json   启动器 ↔ 插件 控制通道
webview2-data\                      WebView2 配置（保存 DSH 会话 Cookie）
```

`launcher.config.json` 由宿主进程的实时事实生成（端口、node 路径、dsh bin、
`NODE_OPTIONS`、工作目录），因此复制出来的启动器启动的就是你正在用的那个后端。

启动器参数：`--debug`、`--hidden`、`--takeover`、`--attach-only`、`--selftest`。
环境变量：`DSH_LAUNCHER_BASE`、`DSH_LAUNCHER_NO_MUTEX=1`、`DSH_DESKTOP_HOME`、
`DSH_DESKTOP_NO_AUTOINSTALL=1`。

## 两个不显然的实现要点

1. **认证**：`dsh web` 用**进程令牌**给壳页面加门禁，启动时打印
   `dsh web: http://127.0.0.1:<port>/?token=…`，访问一次即种下持久签名 Cookie。
   所以启动器必须**自己托管后端**并从 stdout 捕获那一行再导航；外部已启动的后端
   拿不到它的令牌（只存在于那个进程内存里），这就是「接管」存在的原因。
2. **图标**：`System.Drawing` / `NotifyIcon` **不能解码 PNG 压缩的 ICO 条目**（会渲染成噪声），
   所以随包的 `.ico` 里 16/24/32/48/64 都用传统 DIB 条目，只有 128/256 用 PNG。

## 测试

```sh
node test/install.test.mjs     # 21 项：配置 / 安装 / 占用换入 / 快捷方式 / 重启 / 路由
```

## 卸载

```sh
dsh plugin --profile web remove dsh-desktop-shell
```

随后删除 `%USERPROFILE%\dsh-desktop` 与四个快捷方式。安装器不改动 DSH 本体。

## 许可

MIT，见 [LICENSE](LICENSE)。
