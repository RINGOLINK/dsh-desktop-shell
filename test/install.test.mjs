// Functional tests for dsh-desktop: installer core, shortcut script, self-restart helper
// and the host routes — all with seams so nothing touches the real desktop.
process.env.DSH_DESKTOP_TEST = "1";
process.env.DSH_DESKTOP_NO_AUTOINSTALL = "1";

import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const install = await import("../lib/install.js");
const host = await import("../lib/index.js");

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log("  PASS  " + label); }
  catch (error) { failures++; console.log("  FAIL  " + label + " -> " + (error?.message ?? error)); }
};

// Resolve the sandbox to its LONG path: `WScript.Shell.CreateShortcut(...).Save()` fails with
// FileNotFoundException when the folder is expressed with an 8.3 short name (CI runners set
// TEMP=C:\Users\RUNNER~1\...), which would make the live shortcut test fail for the wrong reason.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dsh-desktop-test-")));
const home = join(root, "home");
const folders = {
  desktopDir: join(root, "desktop"),
  startupDir: join(root, "startup"),
  programsDir: join(root, "programs")
};
mkdirSync(folders.desktopDir, { recursive: true });
mkdirSync(folders.startupDir, { recursive: true });
mkdirSync(folders.programsDir, { recursive: true });

// Isolate the WHOLE environment, not just DSH_DESKTOP_HOME: the installer resolves the shell
// folders (Desktop / Startup / Programs) from USERPROFILE and APPDATA, so any code path that
// forgets an explicit folder override must still land inside this sandbox. Without this, a route
// level cleanup during the suite deleted the user's real desktop and start-menu shortcuts.
process.env.USERPROFILE = root;
process.env.APPDATA = join(root, "AppData", "Roaming");
for (const dir of [
  join(root, "Desktop"),
  join(root, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs"),
  join(root, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
]) {
  mkdirSync(dir, { recursive: true });
}

// Pin the dsh bin the host half resolves, so the suite is deterministic on machines (and CI
// runners) where DSH is not installed — the host route would otherwise fail to build a helper.
const fakeDshDir = join(root, "fake-dsh");
mkdirSync(fakeDshDir, { recursive: true });
process.env.DSH_DESKTOP_DSH_BIN = join(fakeDshDir, "bin.js");
writeFileSync(process.env.DSH_DESKTOP_DSH_BIN, "// stand-in for @deepseek-ai/dsh/lib/bin.js\n", "utf8");

const facts = {
  port: 3099,
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  dshBin: "C:\\npx\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
  workingDir: "C:\\Users\\tester",
  nodeOptions: "--max-old-space-size=8192"
};

// ---------------- config resolution ----------------
console.log("[config]");
check("resolveHome: explicit option wins", () => {
  assert.equal(install.resolveHome({ home: "D:\\custom", env: { USERPROFILE: "C:\\p" } }), "D:\\custom");
});
check("resolveHome: DSH_DESKTOP_HOME env override", () => {
  assert.equal(install.resolveHome({ env: { DSH_DESKTOP_HOME: "D:\\env-home", USERPROFILE: "C:\\p" } }), "D:\\env-home");
});
check("resolveHome: defaults to <profile>\\dsh-desktop on Windows", () => {
  assert.equal(install.resolveHome({ env: { USERPROFILE: "C:\\p" }, platform: "win32" }), join("C:\\p", "dsh-desktop"));
});
check("buildLauncherConfig: pins --no-open, keeps host facts, records baseDir", () => {
  const config = install.buildLauncherConfig(facts, { home });
  assert.equal(config.dshArgs, "web --no-open");
  assert.equal(config.port, 3099);
  assert.equal(config.nodePath, facts.nodePath);
  assert.equal(config.dshBin, facts.dshBin);
  assert.equal(config.nodeOptions, "--max-old-space-size=8192");
  assert.equal(config.baseDir, home);
  assert.equal(config.readinessTimeoutSeconds, 45);
});
check("buildLauncherConfig: falls back to the default port", () => {
  assert.equal(install.buildLauncherConfig({ ...facts, port: 0 }, { home }).port, 3080);
});

// ---------------- install plan + install ----------------
console.log("[install]");
check("planInstall: ships the runtime payload plus sources", () => {
  const plan = install.planInstall(facts, { home });
  const names = plan.files.map((f) => f.name);
  for (const required of ["DSHLauncher.exe", "Microsoft.Web.WebView2.Core.dll", "WebView2Loader.dll", "DSHLauncher.ico", "DSHLauncher-debug.ico", "DSHLauncher.cs"]) {
    assert.ok(names.includes(required), "missing " + required);
  }
  assert.equal(plan.exePath, join(home, "DSHLauncher.exe"));
  assert.equal(plan.configPath, join(home, "launcher.config.json"));
});
check("planInstall: ships the checksum manifest and its generator", () => {
  const names = install.planInstall(facts, { home }).files.map((f) => f.name);
  assert.ok(names.includes("SHA256SUMS.txt"), "checksum manifest shipped");
  assert.ok(names.includes("build-checksums.mjs"), "manifest generator shipped");
});
check("installDesktop: copies the payload, writes the config, creates logs/", () => {
  const report = install.installDesktop(facts, { home, shortcuts: false, ...folders });
  assert.equal(report.ok, true, JSON.stringify(report.copied.filter((c) => c.error)));
  assert.equal(report.copied.length, install.RUNTIME_ASSETS.length + install.SOURCE_ASSETS.length);
  assert.ok(existsSync(report.exePath), "exe present");
  assert.ok(existsSync(join(home, "logs")), "logs dir present");
  const config = JSON.parse(readFileSync(report.configPath, "utf8"));
  assert.equal(config.dshArgs, "web --no-open");
  assert.equal(config.port, 3099);
});
check("readStatus: reports the installed shell and its shortcuts", () => {
  const status = install.readStatus({ home, ...folders });
  assert.equal(status.installed, true);
  assert.equal(status.exePresent, true);
  assert.ok(status.exeSize > 0);
  assert.equal(status.config.port, 3099);
  assert.equal(status.shortcuts.main, false, "no shortcut has been created yet");
});
check("copyWithLockFallback: a locked target falls back to a rename swap", () => {
  const calls = [];
  let renamedOnce = false;
  const stubFs = {
    copyFileSync: (from, to) => { calls.push(["copy", from, to]); },
    renameSync: (from, to) => {
      calls.push(["rename", from, to]);
      if (!renamedOnce && to.endsWith("DSHLauncher.exe")) { renamedOnce = true; const error = new Error("EBUSY"); throw error; }
    },
    rmSync: (path) => { calls.push(["rm", path]); },
    existsSync: () => true
  };
  const result = install.copyWithLockFallback({ from: "src.exe", to: join(home, "DSHLauncher.exe") }, { fs: stubFs });
  assert.equal(result, "swapped");
  assert.ok(calls.some(([kind, , to]) => kind === "rename" && String(to).endsWith(".old")), "old file parked");
});

// ---------------- shortcuts ----------------
console.log("[shortcuts]");
check("renderShortcutScript: main/debug/start-menu, sign-in autostart is opt-in", () => {
  const script = install.renderShortcutScript();
  assert.ok(script.includes("DeepSeek Harness.lnk"), "main shortcut");
  assert.ok(script.includes("DeepSeek Harness (调试模式).lnk"), "debug shortcut");
  assert.ok(script.includes("'--debug'"), "debug argument");
  assert.ok(script.includes("deepseek harness.lnk"), "sign-in shortcut");
  assert.ok(script.includes("[switch]$Startup"), "autostart only via the -Startup switch");
  assert.ok(!script.includes("$NoStartup"), "no opt-out switch: autostart is off unless asked for");
  assert.ok(script.includes("if ($Startup) {"), "sign-in shortcut lives inside the -Startup guard");
  assert.ok(script.includes("[switch]$NoStartMenu"), "start-menu opt-out switch");
  assert.ok(script.includes("'*msedge*'"), "Edge PWA migration guard");
  assert.ok(script.includes("Join-Path $startup"), "startup folder placement");
  // Regression: $Home is a read-only PowerShell automatic variable and must never be a parameter.
  assert.ok(!/param\([^)]*\$Home\b/.test(script), "must not declare a $Home parameter");
  assert.ok(script.includes("Join-Path $DshHome"), "uses the non-reserved parameter name");
});
check("createShortcuts: writes the script with a BOM and does NOT add autostart by default", () => {
  const calls = [];
  const runner = (command, args) => { calls.push({ command, args }); return { status: 0, stdout: "OK", stderr: "" }; };
  const result = install.createShortcuts({ home, runner });
  assert.equal(result.ok, true);
  const bytes = readFileSync(result.scriptPath);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM for PowerShell 5.1");
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].args.includes("-Startup"), "no sign-in shortcut unless asked for");
  assert.ok(!calls[0].args.includes("-NoStartMenu"), "start menu stays enabled");
});
check("createShortcuts: startup:true opts the sign-in shortcut in", () => {
  const calls = [];
  const runner = (command, args) => { calls.push({ command, args }); return { status: 0, stdout: "OK", stderr: "" }; };
  install.createShortcuts({ home, runner, startup: true });
  assert.ok(calls[0].args.includes("-Startup"), "sign-in shortcut requested explicitly");
});
check("createShortcuts: dryRun returns the script without writing", () => {
  const result = install.createShortcuts({ home, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.ok(result.script.includes("DSHLauncher.exe"));
});
check("shortcut script keeps the Startup switch and its body variable apart (case-insensitive names)", () => {
  const script = install.renderShortcutScript();
  assert.ok(script.includes("[switch]$Startup"), "the opt-in switch stays");
  assert.ok(script.includes("[string]$StartupPath"), "the folder override stays");
  // PowerShell variables are case-insensitive: `$startup = <string>` while a [switch]$Startup
  // parameter exists aborts the whole script (this silently skipped the start-menu shortcut).
  assert.ok(!/\$startup\s*=\s*\[Environment\]/.test(script), "no string assignment to the switch name");
  assert.ok(script.includes("$startupDir = if ($StartupPath)"), "body variable is distinctly named");

  const startupScript = install.renderStartupShortcutScript();
  assert.ok(startupScript.includes("[string]$StartupPath"), "startup-only script takes a folder override");
  assert.ok(startupScript.includes("Write-Output (\"shortcut: \""), "reports the created path");
});

// ---------------- real PowerShell execution (sandbox folders, no dry-run runner) ----------------
console.log("[shortcuts · live]");
const liveHome = join(root, "live-home");
const liveShim = join(liveHome, "shim");
mkdirSync(liveShim, { recursive: true });
// A real launcher payload is not needed: the script only embeds the exe path into the link.
writeFileSync(join(liveHome, "DSHLauncher.exe"), "stub", "utf8");
writeFileSync(join(liveHome, "DSHLauncher.ico"), "stub", "utf8");
writeFileSync(join(liveHome, "DSHLauncher-debug.ico"), "stub", "utf8");
const liveFolders = {
  desktopDir: join(root, "live-desktop"),
  startupDir: join(root, "live-startup"),
  programsDir: join(root, "live-programs")
};
for (const dir of Object.values(liveFolders)) mkdirSync(dir, { recursive: true });
const liveResult = process.platform === "win32"
  ? install.createShortcuts({ home: liveHome, startup: true, runner: install.spawnRunner, ...liveFolders })
  : { ok: true, skipped: true, created: [], output: "", error: "" };
check("live script run creates desktop/debug/sign-in/start-menu links and exits 0", () => {
  if (liveResult.skipped) return; // PowerShell only exists on Windows
  assert.equal(liveResult.ok, true, "exit status " + liveResult.status + " stderr: " + liveResult.error);
  assert.equal(liveResult.error, "", "no stderr");
  assert.ok(liveResult.created.length >= 4, "reported every created link: " + JSON.stringify(liveResult.created));
  assert.ok(existsSync(join(liveFolders.desktopDir, install.SHORTCUTS.main)));
  assert.ok(existsSync(join(liveFolders.desktopDir, install.SHORTCUTS.debug)));
  assert.ok(existsSync(join(liveFolders.startupDir, install.SHORTCUTS.startup)), "sign-in link created when requested");
  assert.ok(existsSync(join(liveFolders.programsDir, install.SHORTCUTS.startMenu)), "start-menu link created");
});
check("live script run records a shortcut manifest for that home", () => {
  if (liveResult.skipped) return;
  const manifest = install.readShortcutManifest({ home: liveHome });
  assert.ok(manifest !== null, "manifest written");
  assert.equal(manifest.main, join(liveFolders.desktopDir, install.SHORTCUTS.main));
  assert.equal(manifest.debug, join(liveFolders.desktopDir, install.SHORTCUTS.debug), "the Chinese-named debug link is recorded too");
  assert.equal(manifest.startup, join(liveFolders.startupDir, install.SHORTCUTS.startup));
  assert.equal(manifest.startMenu, join(liveFolders.programsDir, install.SHORTCUTS.startMenu));
});
check("shell folders resolve inside the test sandbox", () => {
  const f = install.shellFolders();
  for (const [name, dir] of Object.entries(f)) assert.ok(dir.startsWith(root), name + " escaped the sandbox: " + dir);
});
check("test mode reports deletions instead of performing them", () => {
  const dryFolders = {
    desktopDir: join(root, "dry-desktop"),
    startupDir: join(root, "dry-startup"),
    programsDir: join(root, "dry-programs")
  };
  for (const dir of Object.values(dryFolders)) mkdirSync(dir, { recursive: true });
  const link = join(dryFolders.desktopDir, install.SHORTCUTS.main);
  writeFileSync(link, "stub", "utf8");
  const reported = install.removeShortcuts({ home: join(root, "dry-home"), ...dryFolders });
  assert.equal(reported.dryRun, true, "test mode defaults to report-only");
  assert.ok(reported.wouldRemove.includes(link), "reports the path it would delete");
  assert.deepEqual(reported.removed, []);
  assert.ok(existsSync(link), "nothing was deleted");
  const performed = install.removeShortcuts({ home: join(root, "dry-home"), dryRun: false, ...dryFolders });
  assert.equal(performed.dryRun, false, "an explicit dryRun:false performs the removal");
  assert.equal(existsSync(link), false);
});
check("a shortcut manifest scopes deletion to the links this home created", () => {
  const mHome = join(root, "manifest-home");
  const mFolders = {
    desktopDir: join(root, "m-desktop"),
    startupDir: join(root, "m-startup"),
    programsDir: join(root, "m-programs")
  };
  for (const dir of Object.values(mFolders)) mkdirSync(dir, { recursive: true });
  const owned = join(mFolders.desktopDir, install.SHORTCUTS.main);
  const stray = join(mFolders.desktopDir, "Some Other App.lnk");
  writeFileSync(owned, "stub", "utf8");
  writeFileSync(stray, "stub", "utf8");
  install.writeShortcutManifest([owned], { home: mHome, ...mFolders });
  const report = install.removeShortcuts({ home: mHome, dryRun: false, ...mFolders });
  assert.equal(existsSync(owned), false, "the recorded link is removed");
  assert.ok(existsSync(stray), "an unrecorded link in the same folder survives");
});

// ---------------- sign-in autostart (off by default) ----------------
console.log("[autostart]");
const startupLink = join(folders.startupDir, install.SHORTCUTS.startup);
const okRunner = () => ({ status: 0, stdout: "OK", stderr: "" });
check("readPreferences: autostart is off when nothing was ever configured", () => {
  assert.equal(install.readPreferences({ home }).autostart, false);
});
check("setAutostart(false): deletes the sign-in shortcut and keeps the preference off", () => {
  writeFileSync(startupLink, "stub", "utf8");
  const result = install.setAutostart(false, { home, runner: okRunner, dryRun: false, ...folders });
  assert.equal(result.ok, true);
  assert.equal(result.autostart, false);
  assert.equal(existsSync(startupLink), false, "startup shortcut removed");
  assert.equal(install.readPreferences({ home }).autostart, false);
});
check("setAutostart(true): persists the preference and runs the dedicated startup script", () => {
  const calls = [];
  const runner = (command, args) => { calls.push(args); return { status: 0, stdout: "OK", stderr: "" }; };
  const result = install.setAutostart(true, { home, runner, ...folders });
  assert.equal(result.autostart, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].join(" ").includes("create-startup-shortcut.generated.ps1"), "dedicated script");
  assert.ok(existsSync(join(home, "create-startup-shortcut.generated.ps1")), "script written");
  assert.equal(JSON.parse(readFileSync(join(home, install.PREFERENCES_FILE), "utf8")).autostart, true);
});
check("installDesktop follows the stored preference instead of forcing autostart", () => {
  const calls = [];
  const runner = (command, args) => { calls.push(args); return { status: 0, stdout: "OK", stderr: "" }; };
  install.setAutostart(true, { home, runner: okRunner, ...folders });
  install.installDesktop(facts, { home, runner, ...folders });
  assert.ok(calls.at(-1).includes("-Startup"), "preference on -> -Startup forwarded");
  calls.length = 0;
  install.setAutostart(false, { home, runner: okRunner, ...folders });
  install.installDesktop(facts, { home, runner, ...folders });
  assert.ok(!calls.at(-1).includes("-Startup"), "preference off -> no autostart shortcut");
});
check("cleanupInstall: removes every owned artifact but never the user's Edge shortcut", () => {
  const staging = join(root, "cleanup-home");
  const stagingFolders = {
    desktopDir: join(root, "cleanup-desktop"),
    startupDir: join(root, "cleanup-startup"),
    programsDir: join(root, "cleanup-programs")
  };
  for (const dir of Object.values(stagingFolders)) mkdirSync(dir, { recursive: true });
  install.installDesktop(facts, { home: staging, shortcuts: false });
  const edge = join(stagingFolders.desktopDir, install.SHORTCUTS.edgeBackup);
  writeFileSync(edge, "stub", "utf8");
  writeFileSync(join(stagingFolders.desktopDir, install.SHORTCUTS.main), "stub", "utf8");
  writeFileSync(join(stagingFolders.desktopDir, install.SHORTCUTS.debug), "stub", "utf8");
  writeFileSync(join(stagingFolders.startupDir, install.SHORTCUTS.startup), "stub", "utf8");
  writeFileSync(join(stagingFolders.programsDir, install.SHORTCUTS.startMenu), "stub", "utf8");
  const report = install.cleanupInstall({ home: staging, dryRun: false, ...stagingFolders });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(report.dryRun, false);
  assert.equal(report.homeRemoved, true, "launcher home deleted");
  assert.equal(report.removed.length, 4, "desktop + debug + sign-in + start-menu removed");
  assert.equal(existsSync(staging), false, "launcher home gone");
  assert.ok(existsSync(edge), "the user's Edge PWA shortcut survives");
});

// ---------------- self-restart helper ----------------
console.log("[restart helper]");
check("spawnSelfRestart: silent helper kills, waits for the port, relaunches", () => {
  const result = host.spawnSelfRestart("silent", facts, home);
  assert.equal(result.ok, true);
  assert.equal(result.spawned, false, "test seam must not spawn");
  const text = readFileSync(result.path, "utf8");
  assert.ok(text.includes(`taskkill /PID ${process.pid}`), "kills this host");
  assert.ok(text.includes(":wait") && text.includes("LISTENING"), "waits for the port");
  assert.ok(text.includes("3099"), "targets the live port");
  assert.ok(text.includes("NODE_OPTIONS=--max-old-space-size=8192"), "preserves NODE_OPTIONS");
  assert.ok(text.includes('start "" cmd /c'), "silent relaunch");
  assert.ok(!text.includes("/k "), "no console kept open in silent mode");
});
check("spawnSelfRestart: debug helper opens a visible console", () => {
  const result = host.spawnSelfRestart("debug", facts, home);
  assert.ok(readFileSync(result.path, "utf8").includes('start "DeepSeek Harness (debug)" cmd /k'));
});
check("hostFacts: reports the live process facts", () => {
  const live = host.hostFacts({ webServer: { port: 4321 } });
  assert.equal(live.port, 4321);
  assert.equal(live.nodePath, process.execPath);
  assert.equal(live.workingDir, process.cwd());
});

// ---------------- host routes ----------------
console.log("[routes]");
process.env.DSH_DESKTOP_HOME = home;
const registered = [];
host.apply({
  webServer: { register: (route) => { registered.push(route); return () => {}; } },
  effect: (fn) => fn(),
  logger: { info: () => {} }
});
const route = (path) => registered.find((r) => r.path === path);
check("apply registers status/install/shortcuts/autostart/cleanup/restart routes", () => {
  assert.deepEqual(registered.map((r) => r.path).sort(), [
    "/api/dsh-desktop/autostart",
    "/api/dsh-desktop/cleanup",
    "/api/dsh-desktop/install",
    "/api/dsh-desktop/restart",
    "/api/dsh-desktop/shortcuts",
    "/api/dsh-desktop/status"
  ]);
  assert.ok(registered.every((r) => r.kind === "exact" && typeof r.handler === "function"));
});

function fakeRes() {
  const res = { status: null, body: null, writeHead: (s) => { res.status = s; }, end: (p) => { res.body = p ? JSON.parse(p) : null; }, on: () => res, destroy: () => {} };
  return res;
}
function fakeReq({ method = "GET", address = "127.0.0.1", body = null } = {}) {
  const handlers = {};
  const req = {
    method,
    socket: { remoteAddress: address },
    on: (event, handler) => { (handlers[event] = handlers[event] ?? []).push(handler); return req; },
    destroy: () => {}
  };
  setImmediate(() => {
    if (body !== null) {
      const chunk = Buffer.from(JSON.stringify(body));
      for (const handler of handlers["data"] ?? []) handler(chunk);
    }
    for (const handler of handlers["end"] ?? []) handler();
  });
  return req;
}

const statusRes = fakeRes();
route("/api/dsh-desktop/status").handler(fakeReq(), statusRes);
check("GET /status: installed shell + live facts + preferences", () => {
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.ok, true);
  assert.equal(statusRes.body.status.installed, true);
  assert.equal(statusRes.body.facts.port !== undefined, true);
  assert.equal(typeof statusRes.body.preferences.autostart, "boolean");
  assert.equal(statusRes.body.launcherRunning, false);
});

const forbidden = fakeRes();
route("/api/dsh-desktop/status").handler(fakeReq({ address: "10.0.0.5" }), forbidden);
check("GET /status: rejects non-loopback peers", () => assert.equal(forbidden.status, 403));

const installRes = fakeRes();
await route("/api/dsh-desktop/install").handler(fakeReq({ method: "POST", body: { shortcuts: false } }), installRes);
check("POST /install: repairs the shell", () => {
  assert.equal(installRes.status, 200, JSON.stringify(installRes.body));
  assert.equal(installRes.body.ok, true);
});

// launcher-managed restart path
writeFileSync(join(home, "launcher.state.json"), JSON.stringify({
  pid: process.pid, mode: "silent", backendOwned: true, backendPid: process.pid, updatedAt: new Date().toISOString()
}), "utf8");
const restartLauncher = fakeRes();
await route("/api/dsh-desktop/restart").handler(fakeReq({ method: "POST", body: { mode: "debug" } }), restartLauncher);
check("POST /restart: routes through the running launcher", () => {
  assert.equal(restartLauncher.status, 200, JSON.stringify(restartLauncher.body));
  assert.equal(restartLauncher.body.via, "launcher");
  const command = JSON.parse(readFileSync(join(home, "command.json"), "utf8"));
  assert.equal(command.action, "restart");
  assert.equal(command.mode, "debug");
  assert.equal(command.source, "dsh-desktop-plugin");
});
rmSync(join(home, "command.json"), { force: true });
rmSync(join(home, "launcher.state.json"), { force: true });
const restartSelf = fakeRes();
await route("/api/dsh-desktop/restart").handler(fakeReq({ method: "POST", body: { mode: "silent" } }), restartSelf);
check("POST /restart: falls back to the self-restart helper", () => {
  assert.equal(restartSelf.status, 200, JSON.stringify(restartSelf.body));
  assert.equal(restartSelf.body.via, "self");
  assert.ok(existsSync(join(home, "self-restart.cmd")));
});

const autostartBad = fakeRes();
await route("/api/dsh-desktop/autostart").handler(fakeReq({ method: "POST", body: { enabled: "yes" } }), autostartBad);
check("POST /autostart: rejects a non-boolean payload", () => assert.equal(autostartBad.status, 400));

// An empty home has no launcher: enabling autostart must not create a shortcut to a missing exe.
const emptyHome = join(root, "empty-home");
mkdirSync(emptyHome, { recursive: true });
process.env.DSH_DESKTOP_HOME = emptyHome;
const autostartUninstalled = fakeRes();
await route("/api/dsh-desktop/autostart").handler(fakeReq({ method: "POST", body: { enabled: true } }), autostartUninstalled);
check("POST /autostart: refuses to arm autostart before the shell is installed", () => {
  assert.equal(autostartUninstalled.status, 409, JSON.stringify(autostartUninstalled.body));
  assert.equal(existsSync(join(emptyHome, install.PREFERENCES_FILE)), false, "no preference written");
});
const shortcutsUninstalled = fakeRes();
await route("/api/dsh-desktop/shortcuts").handler(fakeReq({ method: "POST", body: {} }), shortcutsUninstalled);
check("POST /shortcuts: refuses to build shortcuts before the shell is installed", () => {
  assert.equal(shortcutsUninstalled.status, 409, JSON.stringify(shortcutsUninstalled.body));
  assert.equal(existsSync(join(emptyHome, "create-shortcuts.generated.ps1")), false, "no script written");
});
process.env.DSH_DESKTOP_HOME = home;
const shortcutsInstalled = fakeRes();
await route("/api/dsh-desktop/shortcuts").handler(fakeReq({ method: "POST", body: {} }), shortcutsInstalled);
check("POST /shortcuts: rebuilds shortcuts for an installed shell", () => {
  assert.equal(shortcutsInstalled.status, 200, JSON.stringify(shortcutsInstalled.body));
  assert.equal(shortcutsInstalled.body.ok, true);
  assert.ok(existsSync(join(home, "create-shortcuts.generated.ps1")), "script written");
});

const autostartOn = fakeRes();
await route("/api/dsh-desktop/autostart").handler(fakeReq({ method: "POST", body: { enabled: true } }), autostartOn);
check("POST /autostart: enabling stores the preference", () => {
  assert.equal(autostartOn.status, 200, JSON.stringify(autostartOn.body));
  assert.equal(autostartOn.body.autostart, true);
  assert.equal(install.readPreferences({ home }).autostart, true);
});

const autostartOff = fakeRes();
await route("/api/dsh-desktop/autostart").handler(fakeReq({ method: "POST", body: { enabled: false } }), autostartOff);
check("POST /autostart: disabling clears it again", () => {
  assert.equal(autostartOff.body.autostart, false);
  assert.equal(install.readPreferences({ home }).autostart, false);
});

// A running launcher holds its exe open: cleanup must refuse instead of half-deleting.
writeFileSync(join(home, "launcher.state.json"), JSON.stringify({
  pid: process.pid, mode: "silent", backendOwned: true, backendPid: process.pid, updatedAt: new Date().toISOString()
}), "utf8");
const cleanupBlocked = fakeRes();
await route("/api/dsh-desktop/cleanup").handler(fakeReq({ method: "POST", body: {} }), cleanupBlocked);
check("POST /cleanup: refuses while the launcher is running", () => {
  assert.equal(cleanupBlocked.status, 409, JSON.stringify(cleanupBlocked.body));
  assert.ok(existsSync(home), "nothing was deleted");
});
rmSync(join(home, "launcher.state.json"), { force: true });
const cleanupRes = fakeRes();
await route("/api/dsh-desktop/cleanup").handler(fakeReq({ method: "POST", body: {} }), cleanupRes);
check("POST /cleanup: reports the removal instead of deleting while in test mode", () => {
  assert.equal(cleanupRes.status, 200, JSON.stringify(cleanupRes.body));
  assert.equal(cleanupRes.body.dryRun, true, "the route honours the destructive test seam");
  assert.equal(existsSync(home), true, "nothing was deleted");
  assert.deepEqual(cleanupRes.body.removed, []);
});
// The route only accepts a cleanup for an actual installation.
process.env.DSH_DESKTOP_HOME = join(root, "never-installed");
mkdirSync(process.env.DSH_DESKTOP_HOME, { recursive: true });
const cleanupUninstalled = fakeRes();
await route("/api/dsh-desktop/cleanup").handler(fakeReq({ method: "POST", body: {} }), cleanupUninstalled);
check("POST /cleanup: refuses when nothing is installed in that home", () => {
  assert.equal(cleanupUninstalled.status, 409, JSON.stringify(cleanupUninstalled.body));
});
process.env.DSH_DESKTOP_HOME = home;

// ---------------- shipped binary checksums (prebuilt exe provenance) ----------------
// The launcher exe is prebuilt; SHA256SUMS.txt pins it (and the DLLs/icons) so the published
// package can never silently drift from the bytes the manifest describes.
console.log("[checksums]");
const assetDir = new URL("../assets/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const checksums = await import("../assets/build-checksums.mjs");
check("SHA256SUMS.txt matches the shipped binaries byte for byte", () => {
  const recorded = readFileSync(join(assetDir, "SHA256SUMS.txt"), "utf8").trim().split(/\r?\n/).filter((line) => line !== "");
  assert.deepEqual(recorded, checksums.checksumLines(assetDir), "manifest drifted from the packaged bytes");
  assert.equal(recorded.length, checksums.CHECKSUM_ASSETS.length);
  const exeLine = recorded.find((line) => line.endsWith("DSHLauncher.exe"));
  assert.match(exeLine, /^[0-9a-f]{64}  DSHLauncher\.exe$/, "exe hash recorded");
});

// ---------------- browser half (loader wrapper, locale parity, action gating) ----------------
// The browser half is a `window.__ModuleLoader__.load({ id, factory })` bundle, so it is loaded
// here through a stub loader: that catches a renamed module id, a missing locale key and the
// "button enabled for a shell that is not installed" class of bug without a browser.
console.log("[browser half]");
const packageRoot = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const loaded = { id: null, exports: null };
const requireStub = (specifier) => {
  if (specifier === "react") return { useState: () => [null, () => {}], useEffect: () => {} };
  if (specifier === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null, Fragment: null };
  throw new Error("unexpected require: " + specifier);
};
globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded.id = entry.id; loaded.exports = entry.factory(requireStub); } } };
await import(new URL("../lib/client.js", import.meta.url).href);
const client = loaded.exports;
const locales = [];
const slots = [];
client.apply({
  effect: (fn) => fn(),
  locale: { register: (ns, dictionaries) => { locales.push({ ns, dictionaries }); } },
  slots: {
    inject: (slot, register) => register(),
    register: (config, component) => { slots.push({ config, component }); }
  }
});
check("client bundle registers under the package name", () => {
  assert.equal(loaded.id, "dsh-desktop-shell");
});
check("client locale dictionaries stay in lockstep", () => {
  assert.equal(locales.length, 1);
  const { zh, en } = locales[0].dictionaries;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "zh/en key sets must match");
  assert.ok(Object.keys(zh).length > 20, "dictionaries look complete");
});
check("client registers exactly one settings.general.item row", () => {
  assert.equal(slots.length, 1);
  assert.equal(slots[0].config.name, "settings.general.item");
  assert.equal(slots[0].config.order, 88);
  assert.equal(slots[0].component, client.DesktopRow);
});
check("autostartEnabled: preference OR a leftover Startup shortcut counts as on", () => {
  assert.equal(client.autostartEnabled(null), false);
  assert.equal(client.autostartEnabled({ preferences: { autostart: false }, status: { shortcuts: { startup: false } } }), false);
  assert.equal(client.autostartEnabled({ preferences: { autostart: true }, status: { shortcuts: { startup: false } } }), true);
  // Upgraded from <=1.0.1: no preference file, but the shortcut is still there.
  assert.equal(client.autostartEnabled({ preferences: { autostart: false }, status: { shortcuts: { startup: true } } }), true);
});
check("installEnabled / manageEnabled: management needs an installed shell", () => {
  assert.equal(client.installEnabled(null, false), true);
  assert.equal(client.installEnabled("install", false), false, "busy blocks");
  assert.equal(client.installEnabled(null, true), false, "unsupported platform blocks");
  const notInstalled = { status: { installed: false } };
  const installed = { status: { installed: true } };
  assert.equal(client.manageEnabled(notInstalled, null, false), false);
  assert.equal(client.manageEnabled(null, null, false), false, "unknown status blocks management");
  assert.equal(client.manageEnabled(installed, null, false), true);
  assert.equal(client.manageEnabled(installed, "cleanup", false), false, "busy blocks management");
  assert.equal(client.manageEnabled(installed, null, true), false, "unsupported platform blocks management");
});
// Regression: the row once pinned its six-button control group with `flexShrink: 0`. The group kept
// its max-content width, overflowed the settings column (clipping the last button) and squeezed the
// label column down to one character per line.
check("row layout lets the button group wrap instead of squeezing the label column", () => {
  const layout = client.LAYOUT;
  assert.equal(layout.row.flexWrap, "wrap", "the row wraps so the buttons can drop below the text");
  assert.equal(layout.label.minWidth, 0);
  assert.ok(/^1 1 /.test(String(layout.label.flex)), "the label column keeps a real flex basis");
  assert.equal(layout.control.flexWrap, "wrap");
  assert.equal(layout.control.flexShrink, undefined, "the control group must not be pinned at max-content");
  assert.ok(/^0 1 /.test(String(layout.control.flex)), "the control group shrinks before it overflows");
  const button = client.buttonStyle(true);
  assert.equal(button.whiteSpace, "nowrap", "a button never breaks inside its own label");
  assert.equal(button.flex, "0 0 auto");
  assert.equal(client.buttonStyle(false).opacity, 0.6, "disabled buttons render dimmed");
});

// ---------------- package-name consistency (the invariant that really broke) ----------------
// The harness derives a client bundle's expected module id from the PACKAGE NAME and then
// checks `factories.has(id)` after loading the bundle; a mismatch fails the whole page with
// "loaded without registering <pkg> via __ModuleLoader__.load". Renaming the package must
// therefore update every name in lockstep — this section pins that down.
console.log("[package identity]");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const patchText = readFileSync(join(packageRoot, "cordis.patch.yml"), "utf8");
const clientText = readFileSync(join(packageRoot, "lib", "client.js"), "utf8");
const hostText = readFileSync(join(packageRoot, "lib", "index.js"), "utf8");

const patchName = (patchText.match(/^\s*name:\s*(\S+)\s*$/m) ?? [])[1];
const clientId = (clientText.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/) ?? [])[1];
const hostName = (hostText.match(/export const name = "([^"]+)"/) ?? [])[1];

check("package.json declares a name and a dsh.client half", () => {
  assert.equal(typeof packageJson.name, "string");
  assert.equal(packageJson.dsh?.client?.platform, "web");
  assert.equal(packageJson.dsh?.bundle?.patch, "./cordis.patch.yml");
});
check("host half reports the package version (no VERSION drift)", () => {
  assert.equal(install.VERSION, packageJson.version, "lib/install.js VERSION must equal package.json version");
});
check("cordis.patch.yml insert name === package name", () => {
  assert.equal(patchName, packageJson.name);
});
check("client module registers under the PACKAGE name (client-modules: factories.has(id))", () => {
  assert.equal(clientId, packageJson.name, "lib/client.js __ModuleLoader__.load({id}) must equal the package name");
});
check("host half exports the package name", () => {
  assert.equal(hostName, packageJson.name);
});
check("client bundle uses the loader wrapper, not ESM", () => {
  assert.ok(clientText.includes("window.__ModuleLoader__.load("), "must register through the module loader");
  assert.ok(!/^\s*(import|export)\s/m.test(clientText), "browser half must not be an ES module");
});
check("published file list ships the assets the installer copies", () => {
  const files = packageJson.files ?? [];
  assert.ok(files.includes("assets"), "assets must be published (exe + WebView2 payload + icons)");
  assert.ok(files.includes("lib"));
  assert.ok(files.includes("cordis.patch.yml"));
});

rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL DSH-DESKTOP CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
