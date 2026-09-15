# 发布指南（dsh-desktop-shell）

本文是把这个插件开源发布出去的可执行清单，含 DSH 生态现有的所有分发渠道调研结论。

**发布状态（2026-09-13）**：GitHub 仓库 <https://github.com/RINGOLINK/dsh-desktop-shell>（public，CI 绿）；
npm 上 **`dsh-desktop-shell@1.0.0` 已发布**（18 文件 / 373.1 kB / shasum `ae883e8b…`，干净环境 `npm i` 复核通过），后续 1.0.1 / **1.1.0 / 1.1.1 均已按同一条 tag 流程自动发布**（Trusted Publishing，带 provenance），当前 `latest` 以 `npm view dsh-desktop-shell version` 为准；
工作流改为 npm Trusted Publishing（OIDC），社区索引 PR 见 §1 ②。

---

## 0. 先看清楚赛道（2026-09-13 实测 npm registry）

| 包名 | 状态 | 它是什么 | 与本插件的关系 |
| --- | --- | --- | --- |
| `dsh-desktop` | **已被占用**（0.2.0, MIT, `SnowCrescenter-tech/dsh-desktop`） | 独立的 Windows 桌面应用，描述明确写「Do not npm install this — download the installer from GitHub Releases」；**没有 `dsh` 字段，不是 DSH 插件**，靠 GitHub Releases 分发安装包 | 同类目标、不同形态（整包应用 vs 插件） |
| `dsh-web-desktop` | **已被占用**（0.1.2, MIT, `ningbonb/dsh-web-desktop`） | **Electron** 桌面模式 bundle，有 `dsh.bundle.patch`（确实是 DSH 插件），依赖 `electron` | 最接近的先例；我们与它的差别见下 |
| `dsh-desktop-shell` | **可用** ✅ | ← 本插件的发布名 | — |
| `dsh-launcher` / `@deepseek-ai/dsh-desktop` | 未确认 / 官方 scope | `@deepseek-ai/*` 属官方组织，第三方不能占用该 scope | — |

**差异化卖点（建议直接写进 README/索引描述）**：

- **零 Electron 依赖**：复用系统已装的 **WebView2** 运行时（Edge 自带），npm 包仅 ~0.37MB、解包 1.2MB；
  Electron 方案要拉 ~200MB 运行时。
- **免编译、免安装器**：预编译 90KB 的 .NET Framework 4.8 `winexe` 随包分发，装插件即落地，用户机器不需要 VS/编译工具链。
- **原生桌面语义**：真正的「关闭 = 最小化到托盘」「托盘右键才退出并停后端」，以及可见控制台的调试模式。
- **就绪门控**：等后端打印进程令牌 URL（真正就绪）才导航，避免前端未挂载时的 404 闪烁；并自动 `--no-open` 阻止后端再开浏览器标签页。
- **自动接管**：检测到外部启动的后端时可一键重启并纳入启动器托管（外部实例的令牌拿不到，这是唯一可行路径）。
- **设置内控制**：设置 → 通用设置 一行完成安装/修复、重建快捷方式、重启、调试重启。
- **源码随包**：`assets/DSHLauncher.cs` + `build-icons.mjs`，可审计可重编译。

---

## 1. 渠道全景（DSH 插件怎么"开源/发布"）

### ① npm —— 实际的分发与安装通道（必做）

DSH 的插件安装就是：`dsh plugin --profile web add <包名>`（底层 `pnpm add`）。所以**能被安装 = 在 npm 上**。

包必须带 `dsh` 清单字段（本包已具备）：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },   // 声明 bundle 层：安装后自动插入插件行
  "client": { "platform": "web" },               // 声明浏览器半区（client-module 扫描器据此加载）
  "engines": { "dsh": ">=0.1.5-rc.1" }           // 运行期版本门槛（插件管理器会据此禁用/412）
}
```

三个文件形态约定（本包已验证可加载）：
- 宿主半区：ESM，`export const name / inject / apply`；
- 浏览器半区：**不是 ESM**，必须是 `window.__ModuleLoader__.load({ id, factory })` 包装（factory 里 `require("react")`）；
- `cordis.patch.yml` 的 insert 行 `name:` 必须是**裸包名**（写成子路径会被 client 扫描器缓存为"非客户端包"，界面静默不加载）。

发布：

```bash
npm login
npm publish --access public        # 已发布：dsh-desktop-shell@1.0.0（2026-09-13，shasum ae883e8b…）
npm view dsh-desktop-shell version # 复核 → 1.0.0
```

**2FA 与首次发布**：npm 现在要求发布者账号具备 2FA 能力——账号即使显示 `two-factor auth: disabled`，
`npm publish` 也会在 PUT 阶段返回 `E403 … Two-factor authentication or granular access token with bypass 2fa enabled is required`。
两种可行做法：① 在 npm 账号设置里启用 2FA（Authenticator App，模式选 **Authorization and Writes**）后
`npm publish --access public --otp=<6 位动态码>`；② 走 npm 的浏览器校验：npm CLI 只在 `stdin`/`stdout`
都是 TTY 时才提供该分支（`npm/lib/utils/auth.js`），非交互环境可用一个把两路都伪装成 TTY 的 preload
（同时补 `cursorTo`/`clearLine` 等游标方法，否则 npm 的 display 层会崩）启动 npm，
它会打印 `https://www.npmjs.com/auth/cli/<uuid>` 并轮询 done-url，用户在浏览器确认后自动完成发布。

**供应链**：工作流已改用 npm **Trusted Publishing（OIDC）**，仓库内不再保存 `NPM_TOKEN`；
OIDC 发布时 npm 自动生成 provenance 证明。

### ② 社区索引 —— 进入「Workshop 商店」与 dsh-market.com（推荐做）

这是 DSH Web 生态**官方可见的插件目录**：数据源只有一个文件
`@linxin666/dsh-client-ui-community-plugins` 里的 **`community.json`**（仓库 `zhu1090093659/dsh-web`），
它同时驱动：

- Workshop 商店的插件目录；
- 市场站点 [dsh-market.com](https://dsh-market.com) 的 `manifest/plugins.json`；
- 皮肤/宠物/预设清单由同一仓库 `scripts/market-build` 生成。

**登记方式**：按该仓库 `docs/plugins.md` 的「社区插件索引登记」小节提交 PR（维护者审核合并）。
**注意：这是在别人的仓库（`zhu1090093659/dsh-web`）里只增加一条 JSON——只放链接，绝不在这上面传代码；你的代码在自己的仓库。**
条目字段（必填 `id/name/nameEn/author/repo`）：

```json
{
  "id": "dsh-desktop-shell",
  "name": "DSH 桌面外壳",
  "nameEn": "DSH Desktop Shell",
  "author": "RINGOLINK",
  "description": "仅 Windows。把 DSH WebUI 变成本机桌面应用：预编译启动器（WebView2 独立窗口 + 托盘常驻，关闭窗口最小化到托盘，托盘右键才退出）。安装会在 %USERPROFILE%\\dsh-desktop 写入 DSHLauncher.exe 与 WebView2 DLL，并创建桌面/开始菜单快捷方式；登录自启默认关闭，需要时在设置里开启。启动器未托管后端时，「重启后端」会对整个后端进程树执行 taskkill /T /F 强杀再按原参数拉起（会中断进行中的会话）。设置里提供安装/修复、重建快捷方式、登录自启开关、清理安装（删除上述文件与快捷方式）与重启。",
  "descriptionEn": "Windows only. Turns the DSH Web UI into a desktop app: a prebuilt launcher with its own WebView2 window and tray icon (closing the window hides it; only the tray menu exits and stops the backend). Installing writes DSHLauncher.exe and the WebView2 DLLs to %USERPROFILE%\\dsh-desktop and creates desktop/start-menu shortcuts; sign-in autostart is off by default and can be enabled in the settings row. When no launcher manages the backend, restarting it force-kills the whole backend process tree (taskkill /T /F) and relaunches it with the original arguments, interrupting in-flight sessions. The settings row offers install/repair, shortcut rebuild, the autostart switch, removal (deletes those files and shortcuts) and restart.",
  "repo": "https://github.com/RINGOLINK/dsh-desktop-shell",
  "npm": "dsh-desktop-shell",
  "category": "tools",
  "subcategory": "dev"
}
```

**描述必须写全行为**（维护者评审要求）：商店卡片是用户安装前唯一能看到这些的地方，必须写明「仅 Windows /
安装到 `%USERPROFILE%\dsh-desktop`（含 WebView2 DLL）/ 创建哪些快捷方式 / 登录自启默认关闭 / 「重启后端」
的回退路径会 `taskkill /T /F` 强杀整个后端进程树再按原参数拉起」。上面这段是按该要求定稿的，行为变更时同步更新。

`subcategory` 只在 `category` 已填且属于该 category 的合法枚举时才被接受（校验在仓库 `scripts/community-index`）；
另外仓库的 `scripts/market-layout.test.mjs`「plugins.json 契约」要求**凡带 category 的条目必须带非空 subcategory**
（只有未分类的 `other` 桶不带），所以两条都要填。现有枚举里没有 desktop / launcher 类，本条目落在最接近的
`tools` / `dev`（该桶现有 `dsh-plugin-hub`、`dsh-backup` 等环境级工具）；若维护者新增 desktop 子类可迁移。

**分类现状**：现有 `community.json`（61 条）的 `category` 枚举是
`tools / ui / knowledge / integration / utility / security / agent`，其中
`ui: terminal/chat/render/panel`、`agent: preset`、`tools: context/browser/api/model/dev`、
`knowledge: memory/reading/qa`、`integration: remote/bridge/sync/external-ai`、
`security: access/policy`、`utility: cleanup/stats/notify/net`。

### ③ GitHub 仓库 —— 源码主体 + 索引条目的 `repo` 必填项

```bash
cd <插件目录>
git init && git add -A
git commit -m "feat: dsh-desktop-shell 1.0.0"
git remote add origin https://github.com/<你>/dsh-desktop-shell.git
git push -u origin main
```

建议：加 `dsh-plugin` / `deepseek-harness` 话题标签；打 tag 并建 Release；把 `DSHLauncher.cs`、测试
（`test/install.test.mjs`）放进仓库体现可审计性。开发期别人可直接
`dsh plugin --profile web add link:<本地路径>` 或 `file:<tarball>`。

### ④ 其它（了解即可）

- 官方 developer preview 页面：<https://www.deepseek.com/harness/en/>（"Everything is a plugin"）。
- 第三方门户/文档站（社区维护，非官方）：`deepseekdocs.com`、`deepseekagent.io` 等；可作为发布后的推广位。
- 官方插件清单包 `@deepseek-ai/dsh-plugin-package-inventory-deepseek` 属官方组织维护，第三方不进入。
- 注意：本机 `web_fetch` 对 `github.com` / `dsh-market.com` 会因解析到非公网 IP 而拒绝，
  但 `git` / `gh`（走本地代理）与 `registry.npmjs.org`、`docs.npmjs.com` 均正常，
  因此拉仓库、提 PR、发 npm 不必换环境。

---

## 2. 发布前检查清单

- [ ] `node test/install.test.mjs` 全绿（57 项，含 `[package identity]` 身份与版本一致性守卫、`[autostart]` 登录自启默认关闭、`[checksums]` 随包二进制哈希核对、`[browser half]` 装载器 id/双语字典/按钮门控/行布局契约、`[shortcuts · live]` 真机 PowerShell 冒烟与沙箱隔离断言）
- [ ] **四个名字完全一致**（改包名或换 scope 时必须同步改）：
      `package.json` 的 `name` · `cordis.patch.yml` insert 行的 `name` ·
      `lib/client.js` 里 `__ModuleLoader__.load({ id })` · 宿主 `lib/index.js` 的 `export const name`
      —— 该不变量由测试的 `[package identity]` 段强制校验（曾因漏改第 3 个而炸掉整页）
- [ ] `npm pack --dry-run` 输出包含 `assets/`（exe、3 个 DLL、2 个 ico、源码、SHA256SUMS.txt）——本包 20 文件 / ~381 kB（解包 1.2MB）
- [ ] `package.json`：`name` 未被占用、`version` 递增、`license` MIT、`keywords` 含 `dsh-plugin`
- [ ] README.md / README.zh.md 的安装命令与包名一致
- [ ] `dsh.engines.dsh` 与实际依赖的 DSH 版本一致（插件管理器会用它做 412 门禁）
- [ ] 在干净环境验证一次：`dsh plugin --profile web add dsh-desktop-shell` → 重启 → 设置里出现「DSH 桌面外壳」→ 点安装 → 桌面出现快捷方式

## 3. 我们踩过、值得写进 issue/FAQ 的坑

1. **`$Home` 是 PowerShell 只读自动变量**：生成的快捷方式脚本若把参数命名为 `$Home` 会直接失败
   （本包用 `$DshHome`，并加了回归断言）。
2. **`.cmd` 不要写非 ASCII**（cmd 按代码页解析会拆坏命令）；需要中文就放进 **UTF-8 带 BOM 的 `.ps1`**。
3. **.NET 的 `Icon`/`NotifyIcon` 不能解码 PNG 压缩的 ICO 条目**（渲染成噪声/退回默认）：
   16/24/32/48/64 必须用 DIB 条目，128/256 才用 PNG。
4. **覆盖运行中的 exe 会失败（CS2012）**，且失败的编译可能让目标 exe 直接消失：
   先编译到新文件名，再改名/交换，换入前后都要确认文件存在。
5. **`dsh web` 的壳页面有进程令牌门禁**：只有托管后端并捕获它打印的 `?token=…` 行才能显示界面；
   外部实例拿不到令牌，只能接管重启。
6. **自动开浏览器标签页**：`dsh web` 默认把认证 URL 交给默认浏览器，插件必须自动补 `--no-open`。
7. **改包名后必须同步 client 模块 id（本项目真实踩过）**：加载器用**包名**作为客户端模块的期望 id
   （bundle URL 是 `/plugins/<packageName>/client.js`，加载后校验 `factories.has(id)`，见
   `@deepseek-ai/dsh-client-modules` 浏览器侧第 248 行）。包名与 `__ModuleLoader__.load({id})` 不一致时
   **整个 loader entry 导入失败**，前端弹 `Failed to load plugins … loaded without registering "<包名>"`。
   危险之处在于旁证全部正常：`--dump-config` 能看到行、CLI 安装成功、宿主半区也能解析，
   只有浏览器侧加载才报错，极易漏过。发布到 npm scope（`@you/dsh-desktop-shell`）时，
   id 必须是**带 scope 的全名**。
