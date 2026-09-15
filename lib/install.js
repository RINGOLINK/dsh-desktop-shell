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
 *  - desktop / start-menu shortcuts pointing at that launcher, migrating an old
 *    Edge PWA shortcut out of the way instead of clobbering it;
 *  - **no sign-in autostart by default**: the login shortcut is opt-in through
 *    {@link setAutostart} (settings row) and remembered in `preferences.json`;
 *  - {@link cleanupInstall} removes every shortcut this plugin created plus the launcher home,
 *    so uninstalling is one explicit action;
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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Plugin//launcher version shipped by this package. */
export const VERSION = "1.1.3";
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
export const SOURCE_ASSETS = ["DSHLauncher.cs", "build-icons.mjs", "build-checksums.mjs", "SHA256SUMS.txt", "logo.svg"];
/** Shortcut file names created by {@link createShortcuts}. */
export const SHORTCUTS = {
  main: "DeepSeek Harness.lnk",
  debug: "DeepSeek Harness (调试模式).lnk",
  edgeBackup: "DeepSeek Harness (Edge 应用).lnk",
  startup: "deepseek harness.lnk",
  startMenu: "DeepSeek Harness.lnk"
};
const SHORTCUT_SCRIPT = "create-shortcuts.generated.ps1";
const STARTUP_SCRIPT = "create-startup-shortcut.generated.ps1";
/** Records the shortcut files this launcher home created (cleanup only ever deletes these). */
export const SHORTCUT_MANIFEST = "shortcuts.json";
/** Name of the opt-in preference file inside the launcher home. */
export const PREFERENCES_FILE = "preferences.json";

/**
 * Read the persisted preferences of this plugin.
 * Sign-in autostart is **off unless the user turned it on**: anything unreadable, missing or
 * unexpected resolves to `false`, so a deleted or damaged file can never re-arm autostart.
 * @param options - `{ home, env }`.
 * @returns `{ autostart: boolean }`.
 */
export function readPreferences(options = {}) {
  const home = options.home ?? resolveHome(options);
  let raw = null;
  try { raw = JSON.parse(readFileSync(join(home, PREFERENCES_FILE), "utf8")); } catch { }
  return { autostart: raw?.autostart === true };
}

/**
 * Merge a patch into the persisted preferences.
 * @param patch - subset of the preferences object.
 * @param options - `{ home, env }`.
 * @returns the merged preferences.
 */
export function writePreferences(patch = {}, options = {}) {
  const home = options.home ?? resolveHome(options);
  const next = { ...readPreferences({ home }), ...patch };
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, PREFERENCES_FILE), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

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
    // The sign-in shortcut follows the stored preference unless the caller states it outright.
    const startup = options.startup === true ? true : options.startup === false ? false : readPreferences({ home: plan.home }).autostart;
    report.shortcuts = createShortcuts({ home: plan.home, ...options, startup });
  }
  return report;
}

/** Render the shortcut helper script (PowerShell, Chinese names, BOM written by the caller). */
export function renderShortcutScript() {
  return [
    "# NOTE: the launcher home parameter must NOT be called $Home — that is a read-only",
    "# PowerShell automatic variable (the user profile) and would fail the whole script.",
    "# NOTE: PowerShell variable names are case-insensitive, so the body variable for the Startup",
    "# folder must NOT be called $startup while a [switch]$Startup parameter exists (assigning a",
    "# string to a switch parameter aborts the script, which silently skipped the start-menu link).",
    "# The folder paths can be overridden so the script is exercisable against a sandbox.",
    "param(",
    "  [string]$DshHome,",
    "  [switch]$Startup,",
    "  [switch]$NoStartMenu,",
    "  [string]$DesktopPath,",
    "  [string]$StartupPath,",
    "  [string]$ProgramsPath",
    ")",
    "$ErrorActionPreference = 'Stop'",
    "# Report paths as UTF-8: PowerShell 5.1 otherwise encodes redirected stdout with the OEM code",
    "# page, which mangles the Chinese shortcut names for the Node parent process.",
    "try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }",
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
    "$desktopDir = if ($DesktopPath) { $DesktopPath } else { [Environment]::GetFolderPath('Desktop') }",
    "$main = Join-Path $desktopDir 'DeepSeek Harness.lnk'",
    "# Migrate an existing Edge PWA shortcut out of the way instead of clobbering it.",
    "if (Test-Path $main) {",
    "  $current = $shell.CreateShortcut($main)",
    "  if ($current.TargetPath -like '*msedge*') {",
    "    Move-Item $main (Join-Path $desktopDir 'DeepSeek Harness (Edge 应用).lnk') -Force",
    "    Write-Output 'migrated: Edge PWA shortcut preserved as DeepSeek Harness (Edge 应用).lnk'",
    "  }",
    "}",
    "Set-DshShortcut $main $exe '' $ico 'DeepSeek Harness: silent backend start + window; closing keeps it in the tray'",
    "Set-DshShortcut (Join-Path $desktopDir 'DeepSeek Harness (调试模式).lnk') $exe '--debug' $icoDebug 'DeepSeek Harness debug mode: backend output in a visible console'",
    "# Sign-in autostart is opt-in: it exists only when the user enabled it in the settings row.",
    "if ($Startup) {",
    "  $startupDir = if ($StartupPath) { $StartupPath } else { [Environment]::GetFolderPath('Startup') }",
    "  Set-DshShortcut (Join-Path $startupDir 'deepseek harness.lnk') $exe '' $ico 'Start DeepSeek Harness at sign-in'",
    "}",
    "if (-not $NoStartMenu) {",
    "  $programsDir = if ($ProgramsPath) { $ProgramsPath } else { [Environment]::GetFolderPath('Programs') }",
    "  Set-DshShortcut (Join-Path $programsDir 'DeepSeek Harness.lnk') $exe '' $ico 'DeepSeek Harness'",
    "}",
    "try { Start-Process 'ie4uinit.exe' -ArgumentList '-show' -WindowStyle Hidden -Wait } catch { }",
    "Write-Output 'OK'",
    ""
  ].join("\r\n");
}

/** Every shortcut file path the script reported creating (`shortcut: <path>` lines). */
export function parseCreatedShortcuts(stdout) {
  const paths = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const match = /^shortcut:\s*(.+?)\s*$/.exec(line);
    if (match) paths.push(match[1]);
  }
  return paths;
}

/**
 * Record which shortcut files belong to this launcher home.
 * Deletion only ever touches recorded paths, so a cleanup can never remove links that this
 * installation did not create (the reason a stray test invocation deleted real desktop links).
 */
export function readShortcutManifest(options = {}) {
  const home = options.home ?? resolveHome(options);
  try {
    const raw = JSON.parse(readFileSync(join(home, SHORTCUT_MANIFEST), "utf8"));
    return typeof raw === "object" && raw !== null ? raw : null;
  } catch { return null; }
}

/** Merge absolute shortcut paths into the manifest (`{ main, debug, startup, startMenu }`). */
export function writeShortcutManifest(paths, options = {}) {
  const home = options.home ?? resolveHome(options);
  if (!Array.isArray(paths) || paths.length === 0) return readShortcutManifest({ home });
  const folders = shellFolders(options);
  const next = { ...(readShortcutManifest({ home }) ?? {}) };
  for (const path of paths) {
    if (!path.endsWith(".lnk")) continue;
    const name = basename(path);
    if (name === SHORTCUTS.main && dirname(path) === folders.desktop) next.main = path;
    else if (name === SHORTCUTS.debug && dirname(path) === folders.desktop) next.debug = path;
    else if (name === SHORTCUTS.startup && dirname(path) === folders.startup) next.startup = path;
    else if (name === SHORTCUTS.startMenu && dirname(path) === folders.programs) next.startMenu = path;
  }
  next.updatedAt = new Date().toISOString();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, SHORTCUT_MANIFEST), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

/**
 * Create / repair the desktop, debug, start-menu and (opt-in) sign-in shortcuts.
 * @param options - `{ home, startup, startMenu, runner, dryRun }`; `startup` must be `true`
 *   explicitly to also drop the login-autostart shortcut.
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
  if (options.startup === true) args.push("-Startup");
  if (options.startMenu === false) args.push("-NoStartMenu");
  if (options.desktopDir) args.push("-DesktopPath", options.desktopDir);
  if (options.startupDir) args.push("-StartupPath", options.startupDir);
  if (options.programsDir) args.push("-ProgramsPath", options.programsDir);
  const run = options.runner ?? (process.env.DSH_DESKTOP_TEST === "1" ? dryRunRunner : spawnRunner);
  const result = run("powershell.exe", args, { cwd: home });
  // Manifest input is computed from the flags and confirmed on disk, so it never depends on how
  // PowerShell encoded its stdout (the Chinese debug link used to be dropped from the manifest).
  const folders = shellFolders(options);
  const expected = [
    join(folders.desktop, SHORTCUTS.main),
    join(folders.desktop, SHORTCUTS.debug),
    ...(options.startup === true ? [join(folders.startup, SHORTCUTS.startup)] : []),
    ...(options.startMenu === false ? [] : [join(folders.programs, SHORTCUTS.startMenu)])
  ];
  const created = expected.filter((path) => existsSync(path));
  if (result.status === 0 && created.length > 0) writeShortcutManifest(created, { home, ...options });
  return {
    ok: result.status === 0,
    scriptPath,
    created,
    reported: parseCreatedShortcuts(result.stdout),
    status: result.status,
    output: (result.stdout ?? "").trim(),
    error: (result.stderr ?? "").trim()
  };
}

/** Render the minimal script that creates only the sign-in autostart shortcut. */
export function renderStartupShortcutScript() {
  return [
    "param([string]$DshHome, [string]$StartupPath)",
    "$ErrorActionPreference = 'Stop'",
    "try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }",
    "$shell = New-Object -ComObject WScript.Shell",
    "$exe = Join-Path $DshHome 'DSHLauncher.exe'",
    "$ico = Join-Path $DshHome 'DSHLauncher.ico'",
    "$startupDir = if ($StartupPath) { $StartupPath } else { [Environment]::GetFolderPath('Startup') }",
    "$link = $shell.CreateShortcut((Join-Path $startupDir 'deepseek harness.lnk'))",
    "$link.TargetPath = $exe",
    "$link.Arguments = ''",
    "$link.WorkingDirectory = $DshHome",
    "$link.IconLocation = \"$ico,0\"",
    "$link.Description = 'Start DeepSeek Harness at sign-in'",
    "$link.Save()",
    "Write-Output (\"shortcut: \" + (Join-Path $startupDir 'deepseek harness.lnk'))",
    "Write-Output 'OK'",
    ""
  ].join("\r\n");
}

/**
 * Create only the sign-in autostart shortcut (used when the user enables autostart).
 * @param options - `{ home, startupDir, runner, dryRun }`.
 */
export function createStartupShortcut(options = {}) {
  const home = options.home ?? resolveHome(options);
  const scriptPath = join(home, STARTUP_SCRIPT);
  const script = renderStartupShortcutScript();
  if (options.dryRun === true) return { ok: true, dryRun: true, scriptPath, script };
  mkdirSync(home, { recursive: true });
  writeFileSync(scriptPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(script, "utf8")]));
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-DshHome", home];
  if (options.startupDir) args.push("-StartupPath", options.startupDir);
  const run = options.runner ?? (process.env.DSH_DESKTOP_TEST === "1" ? dryRunRunner : spawnRunner);
  const result = run("powershell.exe", args, { cwd: home });
  const startupLink = join(shellFolders(options).startup, SHORTCUTS.startup);
  const created = existsSync(startupLink) ? [startupLink] : [];
  if (result.status === 0 && created.length > 0) writeShortcutManifest(created, { home, ...options });
  return {
    ok: result.status === 0,
    scriptPath,
    created,
    reported: parseCreatedShortcuts(result.stdout),
    status: result.status,
    output: (result.stdout ?? "").trim(),
    error: (result.stderr ?? "").trim()
  };
}

/**
 * Delete the shortcuts this plugin created.
 *
 * Safety model: when the launcher home carries a `shortcuts.json` manifest, deletion is limited to
 * the paths recorded there — a cleanup can then never remove links this installation did not create
 * (a stray invocation once deleted the user's real desktop links because the shell folders were
 * resolved from the ambient profile). Installs that predate the manifest fall back to the default
 * names inside the shell folders. In test mode (`DSH_DESKTOP_TEST=1`) deletions are reported
 * instead of performed unless the caller passes `dryRun: false` explicitly.
 *
 * The Edge-PWA backup shortcut (`… (Edge 应用).lnk`) belongs to the user and is never touched.
 * @param options - `{ home, desktopDir, startupDir, programsDir, names, dryRun }`; `names` limits
 *   the removal to a subset of `main | debug | startup | startMenu`.
 * @returns `{ ok, dryRun, removed, wouldRemove, failed }`.
 */
export function removeShortcuts(options = {}) {
  const home = options.home ?? resolveHome(options);
  const folders = shellFolders(options);
  const defaults = {
    main: join(folders.desktop, SHORTCUTS.main),
    debug: join(folders.desktop, SHORTCUTS.debug),
    startup: join(folders.startup, SHORTCUTS.startup),
    startMenu: join(folders.programs, SHORTCUTS.startMenu)
  };
  const manifest = readShortcutManifest({ home });
  const names = Array.isArray(options.names) && options.names.length > 0 ? options.names : Object.keys(defaults);
  const dryRun = destructiveDryRun(options);
  const removed = [];
  const wouldRemove = [];
  const failed = [];
  for (const name of names) {
    const path = (manifest && typeof manifest[name] === "string") ? manifest[name] : defaults[name];
    if (path === undefined) continue;
    try {
      if (!existsSync(path)) continue;
      if (dryRun) { wouldRemove.push(path); continue; }
      rmSync(path, { force: true });
      removed.push(path);
    } catch (error) {
      failed.push({ path, error: String((error && error.message) || error) });
    }
  }
  return { ok: failed.length === 0, home, dryRun, removed, wouldRemove, failed };
}

/** Test seam: production deletes, `DSH_DESKTOP_TEST=1` only reports unless overridden. */
function destructiveDryRun(options) {
  if (options.dryRun !== undefined) return options.dryRun === true;
  return process.env.DSH_DESKTOP_TEST === "1";
}

/**
 * Turn sign-in autostart on or off: persist the preference, then create or delete the shortcut.
 * @param enabled - desired state.
 * @param options - `{ home, runner, dryRun, ... }`.
 */
export function setAutostart(enabled, options = {}) {
  const home = options.home ?? resolveHome(options);
  const preferences = writePreferences({ autostart: enabled === true }, { home });
  const shortcut = enabled === true
    ? createStartupShortcut({ ...options, home })
    : removeShortcuts({ ...options, home, names: ["startup"] });
  return { ok: shortcut.ok, autostart: preferences.autostart, shortcut };
}

/**
 * Remove everything this plugin installed: its shortcuts, the launcher payload, the generated
 * config and the launcher home itself. Called from the settings row, never automatically —
 * deleting files while the launcher is running is unsafe, so the caller checks that first.
 * @param options - `{ home, removeHome, dryRun, ... }`; `removeHome: false` keeps the launcher
 *   directory; in test mode the removal is reported instead of performed.
 * @returns `{ ok, dryRun, homeRemoved, wouldRemoveHome, removed, wouldRemove, failed, problems }`.
 */
export function cleanupInstall(options = {}) {
  const home = options.home ?? resolveHome(options);
  const shortcuts = removeShortcuts({ ...options, home });
  const dryRun = shortcuts.dryRun;
  const problems = [];
  let homeRemoved = false;
  if (options.removeHome !== false && dryRun !== true) {
    const files = [
      ...RUNTIME_ASSETS,
      ...SOURCE_ASSETS,
      "launcher.config.json",
      PREFERENCES_FILE,
      SHORTCUT_MANIFEST,
      "launcher.state.json",
      "command.json",
      "self-restart.cmd",
      SHORTCUT_SCRIPT,
      STARTUP_SCRIPT
    ];
    for (const name of files) {
      const path = join(home, name);
      try { if (existsSync(path)) rmSync(path, { force: true }); }
      catch (error) { problems.push(`${name}: ${String((error && error.message) || error)}`); }
    }
    try {
      rmSync(home, { recursive: true, force: true });
      homeRemoved = !existsSync(home);
    } catch (error) {
      problems.push(`home: ${String((error && error.message) || error)}`);
    }
  }
  return {
    ok: shortcuts.ok && problems.length === 0,
    home,
    dryRun,
    homeRemoved,
    wouldRemoveHome: dryRun === true && options.removeHome !== false && existsSync(home),
    removed: shortcuts.removed,
    wouldRemove: shortcuts.wouldRemove,
    failed: shortcuts.failed,
    problems
  };
}

/**
 * Runner seam: run the shortcut script to completion and capture its result.
 * Synchronous on purpose — the installer must report the real exit code instead of
 * returning before PowerShell has created anything. Exported so tests can exercise the real
 * PowerShell path against sandbox folders.
 */
export function spawnRunner(command, args, options = {}) {
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
    preferences: readPreferences({ home }),
    installed: exeSize > 0 && config !== null,
    folders
  };
}
