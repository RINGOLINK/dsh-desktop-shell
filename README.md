# dsh-desktop-shell

Turn the DeepSeek Harness Web UI into a **real desktop application** — from inside DSH, as a plugin.

Install the plugin, and it provisions a portable launcher next to your user profile, generates
its configuration from the live host, and creates the desktop / startup / start-menu shortcuts.
No separate installer, no Electron, no build step on the user's machine.

> 中文说明见 [README.zh.md](README.zh.md).

## What you get

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

## Requirements

- **Windows 10/11** (the launcher is a .NET Framework 4.8 WinForms app; the payload is x64)
- **WebView2 Runtime** — preinstalled on current Windows; otherwise install the Evergreen Runtime
- **Node.js ≥ 22** and a DSH installation the launcher can find (`npx` cache or a global install)
- DSH `>= 0.1.5-rc.1`

## Install

```sh
dsh plugin --profile web add dsh-desktop-shell
```

Restart DSH (plugins load at host start), then open **设置 → 通用设置 → DSH 桌面外壳**.
The host half already provisioned everything on activation; the row lets you repair it,
rebuild shortcuts, or restart the backend. Then double-click **DeepSeek Harness** on the desktop.

## What the installer writes

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

## How it works (the two non-obvious parts)

1. **Authentication.** `dsh web` fences the shell behind a per-process token; it prints
   `dsh web: http://127.0.0.1:<port>/?token=…` at startup, and visiting that URL mints the durable
   signed session cookie. The launcher therefore *owns* the backend, captures that line from its
   stdout, and navigates there once. An already-running backend started elsewhere cannot be
   displayed (its token exists only in that process), which is why takeover exists.
2. **Icons.** `System.Drawing`/`NotifyIcon` cannot decode PNG-compressed ICO entries (they render as
   noise), so the small sizes in the shipped `.ico` files are classic DIB entries.

## Tests

```sh
node test/install.test.mjs     # 21 checks: config, install, lock-swap, shortcuts, restart, routes
```

## Uninstall

```sh
dsh plugin --profile web remove dsh-desktop-shell
```

Then delete `%USERPROFILE%\dsh-desktop` and the four shortcuts (desktop ×2, Startup, start menu).
The installer never touches the DSH installation itself.

## License

MIT — see [LICENSE](LICENSE).
