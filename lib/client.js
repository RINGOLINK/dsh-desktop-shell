/**
 * dsh-desktop — browser half.
 *
 * One row in 设置 → 通用设置 (`settings.general.item`): shows whether the desktop shell is
 * installed, and offers install/repair, shortcut rebuild and the two restart actions.
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
    const RESTART_URL = "/api/dsh-desktop/restart";

    const zh = {
      "row.title": "DSH 桌面外壳",
      "row.description": "把 WebUI 变成本机桌面应用：预编译启动器 + WebView2 独立窗口 + 托盘常驻（关闭窗口最小化到托盘，托盘右键才退出）。安装时会按当前环境生成配置并在桌面/开始菜单创建快捷方式。",
      "status.loading": "正在读取安装状态…",
      "status.installed": "已安装 v{version} · {home}",
      "status.missing": "尚未安装（点击「安装 / 修复桌面外壳」）",
      "status.shortcuts": "快捷方式：桌面 {main} · 调试 {debug} · 开机自启 {startup}",
      "status.launcher": "后端由启动器托管（模式：{mode}）",
      "status.standalone": "后端未由启动器托管（自重启模式）",
      "status.unsupported": "当前平台 {platform} 暂不支持（仅 Windows）",
      "status.unavailable": "状态接口不可用（后端可能正在重启）",
      "button.install": "安装 / 修复桌面外壳",
      "button.shortcuts": "重建快捷方式",
      "button.restart": "重启后端",
      "button.debug": "调试模式重启",
      "button.working": "进行中…",
      "result.installed": "桌面外壳已就绪：{count} 个文件 + 快捷方式{shortcuts}。双击桌面「DeepSeek Harness」即可用桌面应用方式启动（当前会话不受影响）。",
      "result.shortcuts": "快捷方式已重建：{output}",
      "result.restartLauncher": "已通知启动器重启后端…",
      "result.restartSelf": "后端正在自重启，页面会在几秒后自动重连…",
      "result.failed": "操作失败：{message}",
      "hint": "提示：安装只写入用户目录，不改动 DSH 本体；卸载时删除安装目录与快捷方式即可。"
    };
    const en = {
      "row.title": "DSH desktop shell",
      "row.description": "Turns the Web UI into a desktop application: a prebuilt launcher with its own WebView2 window and a tray icon (closing the window hides it; only the tray menu exits and stops the backend). Installing generates a config from the live host and creates desktop/start-menu shortcuts.",
      "status.loading": "Reading install status…",
      "status.installed": "installed v{version} · {home}",
      "status.missing": "not installed (use “Install / repair desktop shell”)",
      "status.shortcuts": "shortcuts: desktop {main} · debug {debug} · sign-in {startup}",
      "status.launcher": "backend managed by the launcher (mode: {mode})",
      "status.standalone": "backend not launcher-managed (self-restart mode)",
      "status.unsupported": "not supported on {platform} yet (Windows only)",
      "status.unavailable": "status endpoint unavailable (the backend is probably restarting)",
      "button.install": "Install / repair desktop shell",
      "button.shortcuts": "Rebuild shortcuts",
      "button.restart": "Restart backend",
      "button.debug": "Restart in debug mode",
      "button.working": "Working…",
      "result.installed": "Desktop shell ready: {count} files plus shortcuts{shortcuts}. Double-click “DeepSeek Harness” on the desktop to start it as an app (this session is unaffected).",
      "result.shortcuts": "Shortcuts rebuilt: {output}",
      "result.restartLauncher": "The launcher was asked to restart the backend…",
      "result.restartSelf": "The backend is restarting itself; the page reconnects shortly…",
      "result.failed": "failed: {message}",
      "hint": "The installer only writes to your user directory; it never modifies DSH itself. Uninstalling means deleting the install folder and the shortcuts."
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
            startup: status.status.shortcuts?.startup ? "✓" : "✗"
          }));
        }
        if (!unsupported) {
          parts.push(status.launcherManaged === true
            ? fill(t("status.launcher"), { mode: status.launcher?.mode ?? "-" })
            : t("status.standalone"));
        }
      }

      const buttonStyle = {
        appearance: "none",
        border: "1px solid var(--dsw-alias-border-secondary, #d0d5dd)",
        background: "var(--dsw-alias-bg-secondary, #ffffff)",
        color: "var(--dsw-alias-label-primary, #101828)",
        borderRadius: "8px",
        padding: "6px 14px",
        fontSize: "13px",
        lineHeight: "20px",
        cursor: busy === null ? "pointer" : "default",
        opacity: busy === null ? 1 : 0.6
      };
      const primaryStyle = { ...buttonStyle, borderColor: "var(--dsw-alias-brand-primary, #4d6bfe)", color: "var(--dsw-alias-brand-primary, #4d6bfe)" };
      const secondary = (label, kind) => jsx("button", {
        type: "button",
        style: buttonStyle,
        disabled: busy !== null || unsupported,
        onClick: () => { run(kind); },
        children: busy === kind ? t("button.working") : label
      });

      return jsxs("div", {
        style: {
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "16px",
          padding: "14px 0",
          borderBottom: "1px solid var(--dsw-alias-border-tertiary, #eaecf0)"
        },
        children: [
          jsxs("div", {
            style: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 },
            children: [
              jsx("div", {
                style: { fontSize: "14px", lineHeight: "22px", color: "var(--dsw-alias-label-primary, #101828)" },
                children: t("row.title")
              }),
              jsx("div", {
                style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary, #667085)" },
                children: t("row.description")
              }),
              jsx("div", {
                style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary, #667085)" },
                children: ready ? parts.join(" · ") : t("status.loading")
              }),
              message !== "" ? jsx("div", {
                style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary, #475467)" },
                children: message
              }) : null,
              jsx("div", {
                style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary, #667085)" },
                children: t("hint")
              })
            ]
          }),
          jsxs("div", {
            style: { display: "flex", gap: "8px", flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" },
            children: [
              jsx("button", {
                type: "button",
                style: primaryStyle,
                disabled: busy !== null || unsupported,
                onClick: () => { run("install"); },
                children: busy === "install" ? t("button.working") : t("button.install")
              }),
              secondary(t("button.shortcuts"), "shortcuts"),
              secondary(t("button.restart"), "restart"),
              secondary(t("button.debug"), "debug")
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
    return module.exports;
  }
});
