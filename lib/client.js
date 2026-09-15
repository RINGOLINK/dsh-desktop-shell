/**
 * dsh-desktop — browser half.
 *
 * One row in 设置 → 通用设置 (`settings.general.item`): shows whether the desktop shell is
 * installed, and offers install/repair, shortcut rebuild, the opt-in sign-in autostart switch,
 * removal of everything the plugin installed, and the two restart actions. Management actions stay
 * disabled until the shell is installed, so none of them can create a shortcut to a missing exe.
 *
 * Browser modules load through the harness module loader, so this file uses the
 * `window.__ModuleLoader__.load({ id, factory })` wrapper rather than ESM syntax.
 */
window.__ModuleLoader__.load({
  id: "dsh-desktop-shell",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;

    const NS = "dsh-desktop";
    const STATUS_URL = "/api/dsh-desktop/status";
    const INSTALL_URL = "/api/dsh-desktop/install";
    const SHORTCUTS_URL = "/api/dsh-desktop/shortcuts";
    const AUTOSTART_URL = "/api/dsh-desktop/autostart";
    const CLEANUP_URL = "/api/dsh-desktop/cleanup";
    const RESTART_URL = "/api/dsh-desktop/restart";

    const zh = {
      "row.title": "DSH 桌面外壳",
      "row.description": "把 WebUI 变成本机桌面应用（仅 Windows）：预编译启动器 + WebView2 独立窗口 + 托盘常驻（关闭窗口最小化到托盘，托盘右键才退出）。安装会写入 %USERPROFILE%\\dsh-desktop（含 WebView2 DLL）并创建桌面/开始菜单快捷方式；登录自启默认关闭，需要时在本行手动开启。",
      "status.loading": "正在读取安装状态…",
      "status.installed": "已安装 v{version} · {home}",
      "status.missing": "尚未安装（点击「安装 / 修复桌面外壳」）",
      "status.shortcuts": "快捷方式：桌面 {main} · 调试 {debug} · 开始菜单 {startMenu} · 登录自启 {startup}",
      "status.autostart": "登录自启：{state}",
      "status.autostartOn": "已开启",
      "status.autostartOff": "关闭（默认）",
      "status.launcher": "后端由启动器托管（模式：{mode}）",
      "status.standalone": "后端未由启动器托管（自重启模式）",
      "status.unsupported": "当前平台 {platform} 暂不支持（仅 Windows）",
      "status.unavailable": "状态接口不可用（后端可能正在重启）",
      "button.install": "安装 / 修复",
      "button.shortcuts": "重建快捷方式",
      "button.autostartOn": "开启登录自启",
      "button.autostartOff": "关闭登录自启",
      "button.cleanup": "清理安装",
      "button.restart": "重启后端",
      "button.debug": "调试重启",
      "button.working": "进行中…",
      "result.installed": "桌面外壳已就绪：{count} 个文件 + 快捷方式{shortcuts}。双击桌面「DeepSeek Harness」即可用桌面应用方式启动（当前会话不受影响）。",
      "result.shortcuts": "快捷方式已重建：{output}",
      "result.autostartOn": "已开启登录自启：登录 Windows 后会自动启动桌面外壳。",
      "result.autostartOff": "已关闭登录自启，并删除登录启动项快捷方式。",
      "result.cleanup": "已清理：删除 {shortcuts} 个快捷方式，安装目录 {state}。",
      "result.cleanupKept": "已保留",
      "result.cleanupRemoved": "已删除",
      "result.restartLauncher": "已通知启动器重启后端…",
      "result.restartSelf": "后端正在自重启，页面会在几秒后自动重连…",
      "result.failed": "操作失败：{message}",
      "cleanup.blocked": "启动器正在运行：请先从托盘菜单退出桌面外壳，再执行清理。",
      "hint.summary": "行为说明（点击展开）",
      "hint": "行为说明：安装只写入 %USERPROFILE%\\dsh-desktop（含 DSHLauncher.exe 与 WebView2 DLL），创建桌面/调试/开始菜单快捷方式，登录自启默认关闭；「清理安装」会删除上述文件与快捷方式（启动器运行时需先退出，避免误删正在使用的文件），并会删除 webview2-data 里保存的登录会话（重装后需重新登录）。该目录由插件在宿主启动时自动重建，想让清理保持生效，请先卸载插件（或设置 DSH_DESKTOP_NO_AUTOINSTALL=1）。后端重启在启动器不可用时，会对整个后端进程树执行 taskkill /T /F 强杀后再按原参数拉起。"
    };
    const en = {
      "row.title": "DSH desktop shell",
      "row.description": "Turns the Web UI into a desktop application (Windows only): a prebuilt launcher with its own WebView2 window and a tray icon (closing the window hides it; only the tray menu exits and stops the backend). Installing writes to %USERPROFILE%\\dsh-desktop (including the WebView2 DLLs) and creates desktop/start-menu shortcuts; sign-in autostart is off by default and can be enabled in this row.",
      "status.loading": "Reading install status…",
      "status.installed": "installed v{version} · {home}",
      "status.missing": "not installed (use “Install / repair desktop shell”)",
      "status.shortcuts": "shortcuts: desktop {main} · debug {debug} · start menu {startMenu} · sign-in {startup}",
      "status.autostart": "sign-in autostart: {state}",
      "status.autostartOn": "enabled",
      "status.autostartOff": "off (default)",
      "status.launcher": "backend managed by the launcher (mode: {mode})",
      "status.standalone": "backend not launcher-managed (self-restart mode)",
      "status.unsupported": "not supported on {platform} yet (Windows only)",
      "status.unavailable": "status endpoint unavailable (the backend is probably restarting)",
      "button.install": "Install / repair",
      "button.shortcuts": "Rebuild shortcuts",
      "button.autostartOn": "Enable sign-in autostart",
      "button.autostartOff": "Disable sign-in autostart",
      "button.cleanup": "Remove installation",
      "button.restart": "Restart backend",
      "button.debug": "Debug restart",
      "button.working": "Working…",
      "result.installed": "Desktop shell ready: {count} files plus shortcuts{shortcuts}. Double-click “DeepSeek Harness” on the desktop to start it as an app (this session is unaffected).",
      "result.shortcuts": "Shortcuts rebuilt: {output}",
      "result.autostartOn": "Sign-in autostart enabled: the desktop shell starts when you sign in to Windows.",
      "result.autostartOff": "Sign-in autostart disabled and its startup shortcut removed.",
      "result.cleanup": "Removed {shortcuts} shortcuts; launcher home {state}.",
      "result.cleanupKept": "kept",
      "result.cleanupRemoved": "deleted",
      "result.restartLauncher": "The launcher was asked to restart the backend…",
      "result.restartSelf": "The backend is restarting itself; the page reconnects shortly…",
      "result.failed": "failed: {message}",
      "cleanup.blocked": "The launcher is running: quit the desktop shell from its tray menu, then remove the installation.",
      "hint.summary": "Behaviour notes (click to expand)",
      "hint": "Behaviour: installing only writes to %USERPROFILE%\\dsh-desktop (DSHLauncher.exe plus the WebView2 DLLs) and creates desktop/debug/start-menu shortcuts; sign-in autostart is off by default. “Remove installation” deletes those files and shortcuts (quit the launcher first so nothing in use is deleted) and also drops the sign-in session stored under webview2-data (you sign in again after reinstalling). The plugin recreates that folder when the host starts, so uninstall the plugin (or set DSH_DESKTOP_NO_AUTOINSTALL=1) if the removal has to stick. When no launcher is running, restarting the backend force-kills the whole backend process tree (taskkill /T /F) and relaunches it with the original arguments."
    };

    /** Interpolate {name} placeholders. */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
    }

    /** Read installer status, or null when unreachable. */
    async function readStatus() {
      try {
        const response = await fetch(STATUS_URL, { cache: "no-store" });
        if (!response.ok) return null;
        return await response.json();
      } catch { return null; }
    }

    /** POST one JSON action and return its parsed result. */
    async function post(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {})
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result === null) {
        throw new Error((result && (result.error || result.message)) || `HTTP ${response.status}`);
      }
      return result;
    }

    /**
     * Whether sign-in autostart must be treated as ON for a status payload.
     * A leftover Startup shortcut from an install older than 1.1 counts as ON, so one click on
     * the (then labelled) "disable" action is enough to clean it up.
     * @param status - the `/api/dsh-desktop/status` payload, or null while unknown.
     */
    function autostartEnabled(status) {
      if (status === null || status === undefined) return false;
      return status.preferences?.autostart === true || status.status?.shortcuts?.startup === true;
    }

    /** The install/repair action works on any supported host, installed or not. */
    function installEnabled(busy, unsupported) {
      return busy === null && !unsupported;
    }

    /** Everything else (shortcuts, autostart, removal, restart) needs an installed shell. */
    function manageEnabled(status, busy, unsupported) {
      return installEnabled(busy, unsupported) && status !== null && status !== undefined
        && status.status?.installed === true;
    }

    /**
     * Layout contract of the row, kept outside the component so it can be asserted.
     *
     * The host renders `settings.general.item` rows inside a plain full-width column and its own
     * rows assume a compact control (a stepper or select). This row's control is a *group of
     * buttons*, so the group must be allowed to shrink and wrap: with `flexShrink: 0` it kept its
     * max-content width, overflowed the column (clipping the last button) and squeezed the label
     * column down to one character per line. The label column therefore keeps a real flex basis
     * and the row itself wraps, letting the buttons move below the text on narrow panels.
     */
    const LAYOUT = {
      row: {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-start",
        justifyContent: "space-between",
        columnGap: "16px",
        rowGap: "8px",
        padding: "14px 0",
        borderBottom: "1px solid var(--dsw-alias-border-tertiary, #eaecf0)"
      },
      label: { display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 260px", minWidth: 0 },
      control: {
        display: "flex",
        gap: "8px",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        flex: "0 1 auto",
        minWidth: 0
      },
      lines: { display: "flex", flexDirection: "column", gap: "2px" }
    };

    /** One button style; disabled buttons render dimmed and never break inside their label. */
    function buttonStyleFor(enabled) {
      return {
        appearance: "none",
        border: "1px solid var(--dsw-alias-border-secondary, #d0d5dd)",
        background: "var(--dsw-alias-bg-secondary, #ffffff)",
        color: "var(--dsw-alias-label-primary, #101828)",
        borderRadius: "8px",
        padding: "6px 14px",
        fontSize: "13px",
        lineHeight: "20px",
        flex: "0 0 auto",
        whiteSpace: "nowrap",
        cursor: enabled ? "pointer" : "default",
        opacity: enabled ? 1 : 0.6
      };
    }

    /** The settings row. */
    function DesktopRow({ t }) {
      const [status, setStatus] = react.useState(null);
      const [busy, setBusy] = react.useState(null);
      const [message, setMessage] = react.useState("");

      react.useEffect(() => {
        let cancelled = false;
        const load = async () => {
          const next = await readStatus();
          if (!cancelled) setStatus(next);
        };
        load();
        const timer = setInterval(load, 5000);
        return () => { cancelled = true; clearInterval(timer); };
      }, []);

      const run = async (kind) => {
        if (busy !== null) return;
        setBusy(kind);
        setMessage("");
        try {
          if (kind === "install") {
            const report = await post(INSTALL_URL, {});
            const shortcuts = report.shortcuts === undefined ? "" : (report.shortcuts.ok ? " ✓" : " ✗");
            setMessage(fill(t("result.installed"), { count: report.copied?.length ?? 0, shortcuts }));
          } else if (kind === "shortcuts") {
            const result = await post(SHORTCUTS_URL, {});
            setMessage(fill(t("result.shortcuts"), { output: (result.output ?? "").split(/\r?\n/).slice(-1)[0] ?? "ok" }));
          } else if (kind === "autostartOn" || kind === "autostartOff") {
            const enabled = kind === "autostartOn";
            await post(AUTOSTART_URL, { enabled });
            setMessage(enabled ? t("result.autostartOn") : t("result.autostartOff"));
          } else if (kind === "cleanup") {
            if (status !== null && status.launcherRunning === true) {
              setMessage(t("cleanup.blocked"));
              return;
            }
            const report = await post(CLEANUP_URL, {});
            setMessage(fill(t("result.cleanup"), {
              shortcuts: report.removed?.length ?? 0,
              state: report.homeRemoved === true ? t("result.cleanupRemoved") : t("result.cleanupKept")
            }));
          } else if (kind === "restart" || kind === "debug") {
            const result = await post(RESTART_URL, { mode: kind === "debug" ? "debug" : "silent" });
            setMessage(result.via === "launcher" ? t("result.restartLauncher") : t("result.restartSelf"));
          }
          setStatus(await readStatus());
        } catch (error) {
          setMessage(fill(t("result.failed"), { message: error instanceof Error ? error.message : String(error) }));
        } finally {
          setBusy(null);
        }
      };

      const ready = status !== null;
      const unsupported = ready && status.platform !== "win32";
      const installed = ready && status.status?.installed === true;
      const autostartOn = autostartEnabled(status);
      const canInstall = installEnabled(busy, unsupported);
      const canManage = manageEnabled(status, busy, unsupported);
      const parts = [];
      if (ready) {
        parts.push(unsupported
          ? fill(t("status.unsupported"), { platform: status.platform })
          : installed
            ? fill(t("status.installed"), { version: status.status.version, home: status.status.home })
            : t("status.missing"));
        if (installed && !unsupported) {
          parts.push(fill(t("status.shortcuts"), {
            main: status.status.shortcuts?.main ? "✓" : "✗",
            debug: status.status.shortcuts?.debug ? "✓" : "✗",
            startMenu: status.status.shortcuts?.startMenu ? "✓" : "✗",
            startup: status.status.shortcuts?.startup ? "✓" : "✗"
          }));
          parts.push(fill(t("status.autostart"), {
            state: autostartOn ? t("status.autostartOn") : t("status.autostartOff")
          }));
        }
        if (!unsupported) {
          parts.push(status.launcherManaged === true
            ? fill(t("status.launcher"), { mode: status.launcher?.mode ?? "-" })
            : t("status.standalone"));
        }
      }

      const primaryStyle = {
        ...buttonStyleFor(canInstall),
        borderColor: "var(--dsw-alias-brand-primary, #4d6bfe)",
        color: "var(--dsw-alias-brand-primary, #4d6bfe)"
      };
      const secondary = (label, kind, enabled = true) => jsx("button", {
        type: "button",
        style: buttonStyleFor(enabled),
        disabled: !enabled,
        onClick: () => { run(kind); },
        children: busy === kind ? t("button.working") : label
      });

      return jsxs("div", {
        style: LAYOUT.row,
        children: [
          jsxs("div", {
            style: LAYOUT.label,
            children: [
              jsx("div", {
                style: { fontSize: "14px", lineHeight: "22px", color: "var(--dsw-alias-label-primary, #101828)" },
                children: t("row.title")
              }),
              jsx("div", {
                style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary, #667085)" },
                children: t("row.description")
              }),
              jsxs("div", {
                style: { ...LAYOUT.lines, fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary, #667085)" },
                children: (ready ? parts : [t("status.loading")]).map((line, index) => jsx("div", {
                  key: String(index),
                  children: line
                }))
              }),
              message !== "" ? jsx("div", {
                style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary, #475467)" },
                children: message
              }) : null,
              jsxs("details", {
                style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary, #667085)" },
                children: [
                  jsx("summary", {
                    style: { cursor: "pointer", color: "var(--dsw-alias-label-secondary, #475467)" },
                    children: t("hint.summary")
                  }),
                  jsx("div", {
                    style: { marginTop: "4px" },
                    children: t("hint")
                  })
                ]
              })
            ]
          }),
          jsxs("div", {
            style: LAYOUT.control,
            children: [
              jsx("button", {
                type: "button",
                style: primaryStyle,
                disabled: !canInstall,
                onClick: () => { run("install"); },
                children: busy === "install" ? t("button.working") : t("button.install")
              }),
              secondary(t("button.shortcuts"), "shortcuts", canManage),
              secondary(
                autostartOn ? t("button.autostartOff") : t("button.autostartOn"),
                autostartOn ? "autostartOff" : "autostartOn",
                canManage
              ),
              secondary(t("button.restart"), "restart", canManage),
              secondary(t("button.debug"), "debug", canManage),
              // The destructive action stays last so it is never the easiest button to hit.
              secondary(t("button.cleanup"), "cleanup", canManage)
            ]
          })
        ]
      });
    }

    /** Services required by the browser half. */
    const inject = ["slots", "locale"];

    /** Mount the browser half. */
    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-desktop: dictionaries");
      } catch { /* a missing locale service must not break the plugin */ }
      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "dsh-desktop",
        order: 88,
        locale: NS
      }, DesktopRow));
    }

    exports.NS = NS;
    exports.DesktopRow = DesktopRow;
    exports.apply = apply;
    exports.inject = inject;
    exports.dictionaries = { zh, en };
    exports.autostartEnabled = autostartEnabled;
    exports.installEnabled = installEnabled;
    exports.manageEnabled = manageEnabled;
    exports.LAYOUT = LAYOUT;
    exports.buttonStyle = buttonStyleFor;
    return module.exports;
  }
});
