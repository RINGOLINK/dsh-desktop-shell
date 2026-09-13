/**
 * dsh-desktop — host half.
 *
 * Turns the DSH Web UI into a desktop application by provisioning a portable launcher:
 * on first activation it installs the launcher (prebuilt exe + WebView2 payload + icons),
 * generates a config from the live host facts, and creates the desktop/startup/start-menu
 * shortcuts. The settings row in 通用设置 (see the browser half) drives the same routines
 * on demand.
 *
 * Routes (loopback only):
 *   GET  /api/dsh-desktop/status   -> install status + host facts
 *   POST /api/dsh-desktop/install  -> install / repair the shell ({shortcuts?:boolean})
 *   POST /api/dsh-desktop/restart  -> restart the backend ({mode:"silent"|"debug"})
 * @module dsh-desktop
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createShortcuts, installDesktop, readStatus, resolveHome, shellFolders, VERSION } from "./install.js";

/** Stable Cordis plugin name — must equal the package name (pinned by the consistency test). */
export const name = "dsh-desktop-shell";
/** Required services. */
export const inject = ["webServer"];

const HERE = dirname(fileURLToPath(import.meta.url));
/** How long after activation the auto-provision runs (lets the host finish booting). */
const AUTO_INSTALL_DELAY_MS = 1500;
/** The port used by the self-restart helper's "wait for the port to free" loop. */
const DEFAULT_PORT = 3080;

/**
 * Absolute path of the dsh package this host was started from, when resolvable.
 * `DSH_DESKTOP_DSH_BIN` wins when set, so an unusual install can be pinned explicitly
 * (and the test suite can run on a machine without DSH installed).
 */
function resolveDshBin() {
  const pinned = process.env.DSH_DESKTOP_DSH_BIN ?? "";
  if (pinned !== "" && existsSync(pinned)) return pinned;
  const argv1 = process.argv[1] ?? "";
  if (argv1.endsWith("bin.js") && existsSync(argv1)) return argv1;
  try {
    const cache = join(process.env.LOCALAPPDATA ?? "", "npm-cache", "_npx");
    if (existsSync(cache)) {
      const candidates = readdirSync(cache)
        .map((dir) => join(cache, dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"))
        .filter((candidate) => existsSync(candidate));
      if (candidates.length > 0) {
        candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        return candidates[0];
      }
    }
  } catch { /* fall through */ }
  const globalBin = join(process.env.APPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  return existsSync(globalBin) ? globalBin : "";
}

/** Facts about the running host, used to generate the launcher config. */
export function hostFacts(ctx) {
  let port = DEFAULT_PORT;
  try {
    const live = ctx?.webServer?.port;
    if (Number.isInteger(live) && live > 0) port = live;
  } catch { /* keep the default */ }
  return {
    port,
    nodePath: process.execPath,
    dshBin: resolveDshBin(),
    workingDir: process.cwd(),
    nodeOptions: process.env.NODE_OPTIONS ?? ""
  };
}

/** Loopback-only guard shared by every route. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

/** Read a bounded JSON request body. */
async function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolveBody) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { resolveBody(null); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) { resolveBody({}); return; }
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { resolveBody(null); }
    });
    req.on("error", () => resolveBody(null));
  });
}

/** Read the launcher's published state (null when absent, stale, or the process is gone). */
function launcherState(home) {
  try {
    const path = join(home, "launcher.state.json");
    if (!existsSync(path)) return null;
    const state = JSON.parse(readFileSync(path, "utf8"));
    const pid = Number(state?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); } catch { return null; }
    return state;
  } catch { return null; }
}

/** Ask a running launcher to perform one action. */
function writeLauncherCommand(home, action, mode, source) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "command.json"), JSON.stringify({ action, mode, source, ts: Date.now() }), "utf8");
}

/**
 * Generate the detached self-restart helper (used only when no launcher is running).
 * @param mode - `silent` or `debug`.
 * @param facts - host facts; the helper relaunches the same node + dsh bin.
 * @param home - launcher home that receives the helper.
 * @returns `{ ok, path?, error? }`.
 */
export function spawnSelfRestart(mode, facts, home) {
  if (!facts.dshBin) return { ok: false, error: "cannot resolve the dsh bin.js path" };
  const port = Number(facts.port) || DEFAULT_PORT;
  // Prefer the fact the host captured at install time over the ambient environment, so the
  // helper reproduces exactly the NODE_OPTIONS the running backend was started with.
  const nodeOptions = facts.nodeOptions ?? process.env.NODE_OPTIONS ?? "";
  const lines = [];
  lines.push("@echo off");
  lines.push("rem dsh-desktop self-restart helper - generated automatically, safe to delete");
  lines.push("timeout /t 1 /nobreak >nul");
  lines.push(`taskkill /PID ${process.pid} /T /F >nul 2>&1`);
  lines.push("set /a tries=0");
  lines.push(":wait");
  lines.push("timeout /t 1 /nobreak >nul");
  lines.push(`netstat -ano -p tcp | findstr ":${port} " | findstr "LISTENING" >nul || goto launch`);
  lines.push("set /a tries+=1");
  lines.push("if %tries% LSS 60 goto wait");
  lines.push(`echo [dsh-desktop] port ${port} did not free within 60s; not relaunching >&2`);
  lines.push("exit /b 1");
  lines.push(":launch");
  const preamble = nodeOptions === "" ? "" : `set "NODE_OPTIONS=${nodeOptions}" && `;
  const args = (process.argv.slice(2).filter((value) => value !== "")).join(" ") || "web";
  if (mode === "debug") {
    lines.push(`start "DeepSeek Harness (debug)" cmd /k "${preamble}"${facts.nodePath}" "${facts.dshBin}" ${args}"`);
  } else {
    lines.push(`start "" cmd /c "${preamble}"${facts.nodePath}" "${facts.dshBin}" ${args}"`);
  }
  const path = join(home, "self-restart.cmd");
  mkdirSync(home, { recursive: true });
  writeFileSync(path, lines.join("\r\n") + "\r\n", "utf8");
  if (process.env.DSH_DESKTOP_TEST === "1") return { ok: true, path, spawned: false };
  const child = spawn("cmd.exe", ["/c", path], { detached: true, stdio: "ignore", windowsHide: true, cwd: home });
  child.unref();
  return { ok: true, path, spawned: true };
}

/** Build the loopback routes. */
function makeRoutes(ctx) {
  const facts = () => hostFacts(ctx);
  return [
    {
      kind: "exact",
      path: "/api/dsh-desktop/status",
      handler: (req, res) => {
        if (!isLoopback(req)) { writeJson(res, 403, { error: "forbidden" }); return; }
        if (req.method !== "GET") { writeJson(res, 405, { error: `method not allowed: ${req.method ?? ""}` }); return; }
        const home = resolveHome({});
        const status = readStatus({ home });
        const state = launcherState(home);
        writeJson(res, 200, {
          ok: true,
          platform: process.platform,
          hostPid: process.pid,
          hostUptimeMs: Math.round(process.uptime() * 1000),
          status,
          launcher: state === null ? null : {
            pid: state.pid,
            mode: state.mode,
            backendOwned: state.backendOwned === true,
            backendPid: state.backendPid,
            updatedAt: state.updatedAt
          },
          launcherManaged: state !== null && state.backendOwned === true,
          facts: facts()
        });
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-desktop/install",
      handler: async (req, res) => {
        if (!isLoopback(req)) { writeJson(res, 403, { error: "forbidden" }); return; }
        if (req.method !== "POST") { writeJson(res, 405, { error: `method not allowed: ${req.method ?? ""}` }); return; }
        const body = (await readJsonBody(req)) ?? {};
        try {
          const report = installDesktop(facts(), {
            home: resolveHome({}),
            shortcuts: body.shortcuts !== false,
            startup: body.startup !== false,
            startMenu: body.startMenu !== false
          });
          writeJson(res, report.ok ? 200 : 500, report);
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error && error.message) || error) });
        }
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-desktop/shortcuts",
      handler: async (req, res) => {
        if (!isLoopback(req)) { writeJson(res, 403, { error: "forbidden" }); return; }
        if (req.method !== "POST") { writeJson(res, 405, { error: `method not allowed: ${req.method ?? ""}` }); return; }
        try {
          const result = createShortcuts({ home: resolveHome({}) });
          writeJson(res, result.ok ? 200 : 500, result);
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error && error.message) || error) });
        }
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-desktop/restart",
      handler: async (req, res) => {
        if (!isLoopback(req)) { writeJson(res, 403, { error: "forbidden" }); return; }
        if (req.method !== "POST") { writeJson(res, 405, { error: `method not allowed: ${req.method ?? ""}` }); return; }
        const body = (await readJsonBody(req)) ?? {};
        const mode = body.mode === "debug" ? "debug" : "silent";
        const home = resolveHome({});
        const state = launcherState(home);
        if (state !== null && state.backendOwned === true) {
          try {
            writeLauncherCommand(home, "restart", mode, "dsh-desktop-plugin");
            writeJson(res, 200, { ok: true, via: "launcher", mode, launcherPid: state.pid });
          } catch (error) {
            writeJson(res, 500, { ok: false, error: `cannot reach the launcher: ${String((error && error.message) || error)}` });
          }
          return;
        }
        const result = spawnSelfRestart(mode, facts(), home);
        if (result.ok) writeJson(res, 200, { ok: true, via: "self", mode });
        else writeJson(res, 500, { ok: false, error: result.error });
      }
    }
  ];
}

/**
 * Mount the host half: routes plus a one-shot auto-provision.
 * @param ctx - plugin context carrying the webServer service.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposers = makeRoutes(ctx).map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers) {
        try { dispose?.(); } catch { /* disposal must never throw */ }
      }
    };
  }, "dsh-desktop: routes");
  const logger = (message, detail) => {
    try { ctx.logger?.info?.(`[dsh-desktop] ${message}`, detail ?? ""); }
    catch { /* logging must never break activation */ }
  };
  if (process.platform !== "win32") { logger(`skipped auto-install: unsupported platform ${process.platform}`); return; }
  if (process.env.DSH_DESKTOP_NO_AUTOINSTALL === "1") { logger("auto-install disabled by DSH_DESKTOP_NO_AUTOINSTALL"); return; }
  const timer = setTimeout(() => {
    try {
      const report = installDesktop(hostFacts(ctx), { home: resolveHome({}) });
      const shortcuts = report.shortcuts === undefined ? "" : ` shortcuts=${report.shortcuts.ok ? "ok" : "failed"}`;
      logger(`desktop shell v${VERSION} ready at ${report.home} (files=${report.copied.length}${shortcuts})`);
    } catch (error) {
      logger(`auto-install failed: ${String((error && error.message) || error)}`);
    }
  }, AUTO_INSTALL_DELAY_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export { readStatus, installDesktop, createShortcuts, resolveHome, shellFolders, VERSION };
