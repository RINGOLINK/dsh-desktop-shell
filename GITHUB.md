# 在 GitHub 开源并让别人一键在线安装

> 本机事实（2026-09-13 实测）：`gh` CLI 已登录账号 **RINGOLINK**（token 含 `repo` 权限）· `git ls-remote https://github.com/...` **直连成功** · `npm` **未登录**（发布前需 `npm login`）。
> 注意：本机 harness 的网页抓取工具打不开 github.com（它拒绝非公网 IP 的 fake-IP 解析），但 **git 与 gh 是通的**，所以建仓/推送不受影响。

---

## 0. 两个仓库不要混淆（重要）

| | 仓库 | 作用 | 你的动作 |
| --- | --- | --- | --- |
| **你的账号** | `github.com/RINGOLINK/dsh-desktop-shell` | **存放插件源码与预编译产物** | 建仓 + `git push` ← 这就是"上传" |
| 别人的账号 | `zhu1090093659/dsh-web` | 社区插件**索引**（Workshop 商店与 dsh-market.com 的数据源） | **可选**：提一个 PR 只加一条 JSON（`repo` 字段指向你的仓库），**不要在它上面传任何代码** |

`gh repo create` 建在**当前登录账号**下（本机实测 `gh api user -q .login` = `RINGOLINK`），所以下面第 2 节的命令不会碰到别人的仓库。

---

## 1. 要上传哪些东西

仓库根目录 = 本插件目录 `dsh-desktop-shell/`，**全部 20 个文件都上传**：

```
package.json                 包元数据（name/dsh 清单/files）
cordis.patch.yml             bundle 层插入行（必须与包名一致）
LICENSE                      MIT
README.md / README.zh.md     英文/中文说明
PUBLISHING.md                发布与渠道调研（含 community.json 条目）
GITHUB.md                    本文件
CHANGELOG.md                 版本记录
lib/index.js                 宿主半区（自动安装 + 4 条路由）
lib/install.js               安装器核心（可注入接缝、纯函数）
lib/client.js                浏览器半区（设置 → 通用设置 的「DSH 桌面外壳」行）
assets/DSHLauncher.exe       预编译启动器（90KB，x64）——**必须上传**，这是"免编译"的关键
assets/*.dll                 WebView2 依赖（3 个）
assets/*.ico                 黑白鲸鱼图标（主 / 调试）
assets/DSHLauncher.cs        启动器源码（可审计、可重编译）
assets/build-icons.mjs       图标生成脚本
assets/logo.svg              品牌矢量素材
test/install.test.mjs        27 项测试（含身份一致性守卫）
.github/workflows/ci.yml     CI：Windows + Node 22/24 跑测试
.github/workflows/publish.yml 打 tag 自动 npm 发布（带 provenance）
.gitignore / .gitattributes  忽略运行时产物、保护二进制文件
```

**不要上传**（`.gitignore` 已排除；这些是运行期产物，不是源码）：

```
node_modules/               依赖（本包零依赖，CI 也不需要装）
logs/  webview2-data/       运行日志与 WebView2 配置（含你的会话 Cookie！）
launcher.state.json         启动器运行状态
command.json                启动器 ↔ 插件控制文件
self-restart.cmd            运行期生成的重启助手
create-shortcuts.generated.ps1  运行期生成的快捷方式脚本
*.tgz                       npm 打包产物
```

## 2. 建仓 + 首次推送（本机可直接执行）

```powershell
cd <你的插件目录>       # 例如 D:\dev\dsh-desktop-shell（本仓库根目录）

git init -b main
git add -A
git commit -m "feat: dsh-desktop-shell 1.0.0 — native desktop shell for DSH (WebView2 + tray, no Electron)"

# gh 已登录，这一条会同时创建公开仓库并推送，自动配好凭据
gh repo create dsh-desktop-shell --public --source . --push --description "Turn the DeepSeek Harness Web UI into a real desktop app from inside DSH: WebView2 window, tray residency, silent start, debug console. No Electron."

# 建议顺手加话题标签（便于被发现）
gh repo edit RINGOLINK/dsh-desktop-shell --add-topic dsh-plugin --add-topic deepseek-harness --add-topic desktop --add-topic webview2 --add-topic windows

# 打 tag（会触发 .github/workflows/publish.yml；若还没配 npm token 可先不打）
git tag v1.0.0 && git push --tags
```

> 若用 HTTPS 推送时要输密码：先执行 `gh auth setup-git` 把 gh 的凭据助手接给 git。
>
> **想先自己审一遍再公开**：把 `--public` 换成 `--private` 建私有仓库（本项目的实际做法），
> 看完之后再转公开：
> ```powershell
> gh repo edit RINGOLINK/dsh-desktop-shell --visibility public --accept-visibility-change-consequences
> # 或网页：Settings → General → Danger Zone → Change visibility
> ```
>
> ⚠️ **`workflow` 权限坑（本项目真实踩过）**：若 gh 的 token 不含 `workflow` scope，推送含
> `.github/workflows/*` 的提交会被拒：
> `refusing to allow an OAuth App to create or update workflow ... without 'workflow' scope`。
> 两种解法：① 补权限后重推——`gh auth refresh -h github.com -s workflow`（浏览器点一次授权），
> 再 `git add .github && git commit -m "ci: add workflows" && git push`；
> ② 用网页端 Add file → Upload files 直接上传这两个 yml（现有 `repo` 权限即可）。

## 3. 让别人"快速在线安装"的三条路

| 方式 | 用户要输入的命令/操作 | 优点 | 限制 |
| --- | --- | --- | --- |
| **① npm（主推）** | `dsh plugin --profile web add dsh-desktop-shell` | 一条命令；**插件管理器的更新按钮可用**（管理器只对 npm 直连源提供更新） | 需要先发布到 npm |
| **② GitHub git 源** | `dsh plugin --profile web add github:RINGOLINK/dsh-desktop-shell` | 不用 npm，仓库一推就能装；也可 `git+https://github.com/…` | 需本机有 git 且能访问 GitHub；**更新按钮不管这类源**（源码已确认：`lib/index.js:586` 把 `github:`/`git:`/`git+`/`link:`/`file:` 归为 `git` 源，更新路径只处理 `npm` 直连源） |
| **③ 社区索引（最省事）** | 设置 → 插件市场/Workshop 商店里点「安装」 | 图形界面一键装，自动进 `dsh-market.com` 与商店目录 | 需要提 PR 被维护者合并（见下） |

安装后都要**重启 DSH**，然后浏览器 **Ctrl+F5**；设置 → 通用设置 会出现「**DSH 桌面外壳**」行，桌面/启动/开始菜单快捷方式由安装器自动创建（旧 Edge PWA 快捷方式会被改名保留）。

### 3.1 发布到 npm（实现路径 ①）

```powershell
npm login                     # 本机当前未登录；浏览器完成授权
npm publish --access public   # 包名 dsh-desktop-shell（已确认未被占用）
npm view dsh-desktop-shell version
```

之后每次发版：改 `package.json` 的 version → 提交 → `git tag vX.Y.Z && git push --tags`（CI 会用 `NPM_TOKEN` 自动发布并附 provenance）。

### 3.2 进社区索引（实现路径 ③，一次性 PR）

1. Fork `zhu1090093659/dsh-web`；
2. 按该仓库 `docs/plugins.md` 的「社区插件索引登记」小节，向 `community.json` 追加一条（条目 JSON 已备在 `PUBLISHING.md` 第 1 节，字段：`id/name/nameEn/author/repo/description/descriptionEn/npm/category/subcategory`）；
3. `author` 填 `RINGOLINK`，`repo` 填你的仓库地址，`npm` 填 `dsh-desktop-shell`；
4. `category` 建议 `utility`，`subcategory` 建议新增 `desktop`（现有枚举里没有桌面类，PR 里请维护者确认）；
5. 提 PR → 维护者审核合并 → `scripts/market-build` 生成商店与 `dsh-market.com/manifest/plugins.json`。

## 4. 发布前自检（每次都要）

```powershell
node test/install.test.mjs    # 27 项；[package identity] 段会拦住"包名/模块 id 不一致"
npm pack --dry-run            # 确认 17 个发布文件里含 assets/
```

改名或换 scope 时，四处必须同步：`package.json` 的 `name`、`cordis.patch.yml` 的 insert `name`、
`lib/client.js` 的 `__ModuleLoader__.load({ id })`、宿主 `lib/index.js` 的 `export const name`。
（发布到 scope 下时，四处都用带 scope 的全名，如 `@ringolink/dsh-desktop-shell`。）
