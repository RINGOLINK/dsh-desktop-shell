// Functional tests for dsh-desktop: installer core, shortcut script, self-restart helper
// and the host routes — all with seams so nothing touches the real desktop.
process.env.DSH_DESKTOP_TEST = "1";
process.env.DSH_DESKTOP_NO_AUTOINSTALL = "1";

import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const install = await import("../lib/install.js");
const host = await import("../lib/index.js");

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log("  PASS  " + label); }
  catch (error) { failures++; console.log("  FAIL  " + label + " -> " + (error?.message ?? error)); }
};

const root = mkdtempSync(join(tmpdir(), "dsh-desktop-test-"));
const home = join(root, "home");
const folders = {
  desktopDir: join(root, "desktop"),
  startupDir: join(root, "startup"),
  programsDir: join(root, "programs")
};
mkdirSync(folders.desktopDir, { recursive: true });
mkdirSync(folders.startupDir, { recursive: true });
mkdirSync(folders.programsDir, { recursive: true });

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
check("renderShortcutScript: main/debug/startup/start-menu + Edge migration", () => {
  const script = install.renderShortcutScript();
  assert.ok(script.includes("DeepSeek Harness.lnk"), "main shortcut");
  assert.ok(script.includes("DeepSeek Harness (调试模式).lnk"), "debug shortcut");
  assert.ok(script.includes("'--debug'"), "debug argument");
  assert.ok(script.includes("deepseek harness.lnk"), "startup shortcut");
  assert.ok(script.includes("$NoStartup") && script.includes("$NoStartMenu"), "opt-out switches");
  assert.ok(script.includes("'*msedge*'"), "Edge PWA migration guard");
  assert.ok(script.includes("Join-Path $startup"), "startup folder placement");
  // Regression: $Home is a read-only PowerShell automatic variable and must never be a parameter.
  assert.ok(!/param\([^)]*\$Home\b/.test(script), "must not declare a $Home parameter");
  assert.ok(script.includes("Join-Path $DshHome"), "uses the non-reserved parameter name");
});
check("createShortcuts: writes the script with a BOM and passes the opt-out switches", () => {
  const calls = [];
  const runner = (command, args) => { calls.push({ command, args }); return { status: 0, stdout: "OK", stderr: "" }; };
  const result = install.createShortcuts({ home, runner, startup: false, startMenu: true });
  assert.equal(result.ok, true);
  const bytes = readFileSync(result.scriptPath);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM for PowerShell 5.1");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("-NoStartup"), "startup opt-out forwarded");
  assert.ok(!calls[0].args.includes("-NoStartMenu"), "start menu stays enabled");
});
check("createShortcuts: dryRun returns the script without writing", () => {
  const result = install.createShortcuts({ home, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.ok(result.script.includes("DSHLauncher.exe"));
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
check("apply registers status/install/shortcuts/restart routes", () => {
  assert.deepEqual(registered.map((r) => r.path).sort(), [
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
check("GET /status: installed shell + live facts", () => {
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.ok, true);
  assert.equal(statusRes.body.status.installed, true);
  assert.equal(statusRes.body.facts.port !== undefined, true);
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

// ---------------- package-name consistency (the invariant that really broke) ----------------
// The harness derives a client bundle's expected module id from the PACKAGE NAME and then
// checks `factories.has(id)` after loading the bundle; a mismatch fails the whole page with
// "loaded without registering <pkg> via __ModuleLoader__.load". Renaming the package must
// therefore update every name in lockstep — this section pins that down.
console.log("[package identity]");
const packageRoot = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
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
