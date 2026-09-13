/**
 * dsh-desktop — installer core.
 *
 * Everything here is side-effect explicit and seam-injected (fs, runner, platform, env) so
 * the whole install/status flow can be unit-tested without touching a real desktop.
 *
 * What the installer guarantees:
 *  - a portable launcher home (default `%USERPROFILE%\dsh-desktop`) holding the prebuilt
 *    `DSHLauncher.exe`, the WebView2 SDK files, the two whale icons and the launcher source;
 *  - a `launcher.config.json` generated from the *live* host facts (port, node, dsh bin,
 *    NODE_OPTIONS, working directory) so the copied shell starts the same backend the user
 *    is already running;
 *  - desktop / startup / start-menu shortcuts pointing at that launcher, migrating an old
 *    Edge PWA shortcut out of the way instead of clobbering it;
 *  - safe replacement of a launcher exe that is currently running (rename-swap fallback).
 * @module dsh-desktop/install
 */
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Plugin//launcher version shipped by this package. */
export const VERSION = "1.0.0";
const HERE = dirname(fileURLToPath(import.meta.url));
/** Absolute path of the packaged assets (exe, WebView2 DLLs, icons, source). */
export const ASSET_DIR = resolve(HERE, "..", "assets");

/** Files copied next to the launcher exe (runtime payload). */
export const RUNTIME_ASSETS = [
  "DSHLauncher.exe",
  "Microsoft.Web.WebView2.Core.dll",
  "Microsoft.Web.WebView2.WinForms.dll",
  "WebView2Loader.dll",
  "DSHLauncher.ico",
  "DSHLauncher-debug.ico"
];
/** Files copied for transparency / rebuilds (not required at runtime). */
export const SOURCE_ASSETS = ["DSHLauncher.cs", "build-icons.mjs", "logo.svg"];
/** Shortcut file names created by {@link createShortcuts}. */
export const SHORTCUTS = {
  main: "DeepSeek Harness.lnk",
  debug: "DeepSeek Harness (调试模式).lnk",
  edgeBackup: "DeepSeek Harness (Edge 应用).lnk",
  startup: "deepseek harness.lnk",
  startMenu: "DeepSeek Harness.lnk"
};
const SHORTCUT_SCRIPT = "create-shortcuts.generated.ps1";

/** Resolve the launcher home: explicit option, env override, then the user profile. */
export function resolveHome(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (options.home !== undefined && options.home !== "") return resolve(options.home);
  if (env.DSH_DESKTOP_HOME !== undefined && env.DSH_DESKTOP_HOME !== "") return resolve(env.DSH_DESKTOP_HOME);
  if (platform === "win32") {
    const profile = env.USERPROFILE ?? env.HOME ?? "";
    if (profile !== "") return join(profile, "dsh-desktop");
  }
  const home = env.HOME ?? env.USERPROFILE ?? ".";
  return join(home, "dsh-desktop");
}

/** Shell folders used for shortcut placement (overridable for tests). */
export function shellFolders(options = {}) {
  const env = options.env ?? process.env;
  const profile = env.USERPROFILE ?? env.HOME ?? ".";
  return {
    desktop: options.desktopDir ?? join(profile, "Desktop"),
    startup: options.startupDir ?? join(env.APPDATA ?? join(profile, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
    programs: options.programsDir ?? join(env.APPDATA ?? join(profile, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs")
  };
}

/**
 * Build the launcher config from live host facts.
 * @param facts - `{ port, nodePath, dshBin, workingDir, nodeOptions }`.
 * @param options - `{ home }` target directory.
 * @returns the JSON-serializable config object.
 */
export function buildLauncherConfig(facts, options = {}) {
  const home = options.home ?? resolveHome(options);
  return {
    port: Number(facts.port) || 3080,
    nodePath: facts.nodePath ?? "",
    dshBin: facts.dshBin ?? "",
    dshArgs: "web --no-open",
    workingDir: facts.workingDir ?? "",
    nodeOptions: facts.nodeOptions ?? "",
    readinessTimeoutSeconds: 45,
    baseDir: home
  };
}

/** Pure install plan: what would be written where. */
export function planInstall(facts, options = {}) {
  const home = options.home ?? resolveHome(options);
  const assets = [...RUNTIME_ASSETS, ...SOURCE_ASSETS];
  return {
    home,
    exePath: join(home, "DSHLauncher.exe"),
    configPath: join(home, "launcher.config.json"),
    logsDir: join(home, "logs"),
    files: assets.map((name) => ({ name, from: join(ASSET_DIR, name), to: join(home, name) })),
    config: buildLauncherConfig(facts, { home, ...options })
  };
}

/**
 * Copy one file, tolerating a target that is currently in use (a running launcher).
 * Strategy: copy to `<name>.new`, then rename it over the target; when the target itself is
 * locked, move the old file aside first and clean it up afterwards.
 * @returns `"copied" | "replaced" | "swapped"`.
 */
export function copyWithLockFallback(plan, options = {}) {
  const fsx = options.fs ?? { copyFileSync, renameSync, rmSync, existsSync };
  mkdirSync(dirname(plan.to), { recursive: true });
  const fresh = plan.to + ".new";
  try { rmSync(fresh, { force: true }); } catch { }
  fsx.copyFileSync(plan.from, fresh);
  try {
    fsx.renameSync(fresh, plan.to);
    return "copied";
  } catch {
    const parked = plan.to + ".old";
    try { rmSync(parked, { force: true }); } catch { }
    try { fsx.renameSync(plan.to, parked); } catch { }
    fsx.renameSync(fresh, plan.to);
    try { rmSync(parked, { force: true }); } catch { }
    return "swapped";
  }
}

/**
 * Install (or repair) the desktop shell.
 * @param facts - live host facts from {@link buildLauncherConfig}.
 * @param options - `{ home, shortcuts, startup, startMenu, runner, fs, env, platform }`.
 * @returns a report describing every action taken.
 */
export function installDesktop(facts, options = {}) {
  const plan = planInstall(facts, options);
  mkdirSync(plan.home, { recursive: true });
  mkdirSync(plan.logsDir, { recursive: true });
  const copied = [];
  for (const file of plan.files) {
    try {
      copied.push({ name: file.name, result: copyWithLockFallback(file, options) });
    } catch (error) {
      copied.push({ name: file.name, error: String((error && error.message) || error) });
    }
  }
  writeFileSync(plan.configPath, JSON.stringify(plan.config, null, 2) + "\n", "utf8");
  const report = {
    ok: copied.every((entry) => entry.error === undefined),
    version: VERSION,
    home: plan.home,
    exePath: plan.exePath,
    configPath: plan.configPath,
    copied,
    config: plan.config
  };
  if (options.shortcuts !== false) {
    report.shortcuts = createShortcuts({ home: plan.home, ...options });
  }
  return report;
}

/** Render the shortcut helper script (PowerShell, Chinese names, BOM written by the caller). */
export function renderShortcutScript() {
  return [
    "# NOTE: the launcher home parameter must NOT be called $Home — that is a read-only",
    "# PowerShell automatic variable (the user profile) and would fail the whole script.",
    "param([string]$DshHome, [switch]$NoStartup, [switch]$NoStartMenu)",
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject WScript.Shell",
    "function Set-DshShortcut($path, $target, $arguments, $icon, $description) {",
    "  $link = $shell.CreateShortcut($path)",
    "  $link.TargetPath = $target",
    "  $link.Arguments = $arguments",
    "  $link.WorkingDirectory = $DshHome",
    "  $link.IconLocation = \"$icon,0\"",
    "  $link.Description = $description",
    "  $link.Save()",
    "  Write-Output (\"shortcut: \" + $path)",
    "}",
    "$exe = Join-Path $DshHome 'DSHLauncher.exe'",
    "$ico = Join-Path $DshHome 'DSHLauncher.ico'",
    "$icoDebug = Join-Path $DshHome 'DSHLauncher-debug.ico'",
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    "$main = Join-Path $desktop 'DeepSeek Harness.lnk'",
    "# Migrate an existing Edge PWA shortcut out of the way instead of clobbering it.",
    "if (Test-Path $main) {",
    "  $current = $shell.CreateShortcut($main)",
    "  if ($current.TargetPath -like '*msedge*') {",
    "    Move-Item $main (Join-Path $desktop 'DeepSeek Harness (Edge 应用).lnk') -Force",
    "    Write-Output 'migrated: Edge PWA shortcut preserved as DeepSeek Harness (Edge 应用).lnk'",
    "  }",
    "}",
    "Set-DshShortcut $main $exe '' $ico 'DeepSeek Harness: silent backend start + window; closing keeps it in the tray'",
    "Set-DshShortcut (Join-Path $desktop 'DeepSeek Harness (调试模式).lnk') $exe '--debug' $icoDebug 'DeepSeek Harness debug mode: backend output in a visible console'",
    "if (-not $NoStartup) {",
    "  $startup = [Environment]::GetFolderPath('Startup')",
    "  Set-DshShortcut (Join-Path $startup 'deepseek harness.lnk') $exe '' $ico 'Start DeepSeek Harness at sign-in'",
    "}",
    "if (-not $NoStartMenu) {",
    "  $programs = [Environment]::GetFolderPath('Programs')",
    "  Set-DshShortcut (Join-Path $programs 'DeepSeek Harness.lnk') $exe '' $ico 'DeepSeek Harness'",
    "}",
    "try { Start-Process 'ie4uinit.exe' -ArgumentList '-show' -WindowStyle Hidden -Wait } catch { }",
    "Write-Output 'OK'",
    ""
  ].join("\r\n");
}

/**
 * Create / repair the desktop, debug, startup and start-menu shortcuts.
 * @param options - `{ home, startup, startMenu, runner, dryRun }`.
 * @returns `{ ok, scriptPath, output }`.
 */
export function createShortcuts(options = {}) {
  const home = options.home ?? resolveHome(options);
  const scriptPath = join(home, SHORTCUT_SCRIPT);
  const script = renderShortcutScript();
  if (options.dryRun === true) return { ok: true, dryRun: true, scriptPath, script };
  mkdirSync(home, { recursive: true });
  // PowerShell 5.1 reads a BOM-less file as ANSI, mangling the Chinese shortcut names.
  writeFileSync(scriptPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(script, "utf8")]));
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-DshHome", home];
  if (options.startup === false) args.push("-NoStartup");
  if (options.startMenu === false) args.push("-NoStartMenu");
  const run = options.runner ?? (process.env.DSH_DESKTOP_TEST === "1" ? dryRunRunner : defaultRunner);
  const result = run("powershell.exe", args, { cwd: home });
  return {
    ok: result.status === 0,
    scriptPath,
    status: result.status,
    output: (result.stdout ?? "").trim(),
    error: (result.stderr ?? "").trim()
  };
}

/**
 * Default runner seam: run the shortcut script to completion and capture its result.
 * Synchronous on purpose — the installer must report the real exit code instead of
 * returning before PowerShell has created anything.
 */
function defaultRunner(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    windowsHide: true,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60000
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error.message ?? result.error) : "")
  };
}

/** Test seam: pretend the shortcut script ran without touching the real shell. */
function dryRunRunner(command, args) {
  return { status: 0, stdout: `dry-run: ${command} ${args.join(" ")}`, stderr: "" };
}

/** Report what is currently installed (no side effects). */
export function readStatus(options = {}) {
  const home = options.home ?? resolveHome(options);
  const folders = shellFolders(options);
  const exePath = join(home, "DSHLauncher.exe");
  const configPath = join(home, "launcher.config.json");
  let config = null;
  try { config = JSON.parse(readFileSync(configPath, "utf8")); } catch { }
  const files = [...RUNTIME_ASSETS].map((name) => ({ name, present: existsSync(join(home, name)) }));
  const shortcuts = {
    main: existsSync(join(folders.desktop, SHORTCUTS.main)),
    debug: existsSync(join(folders.desktop, SHORTCUTS.debug)),
    startup: existsSync(join(folders.startup, SHORTCUTS.startup)),
    startMenu: existsSync(join(folders.programs, SHORTCUTS.startMenu))
  };
  let exeSize = 0;
  try { exeSize = statSync(exePath).size; } catch { }
  return {
    version: VERSION,
    home,
    exePath,
    exePresent: exeSize > 0,
    exeSize,
    configPath,
    config,
    files,
    shortcuts,
    installed: exeSize > 0 && config !== null,
    folders
  };
}
