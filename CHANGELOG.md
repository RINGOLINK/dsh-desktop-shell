# Changelog

All notable changes to `dsh-desktop-shell` are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [1.1.3] — 2026-09-15

### Fixed
- **The debug shortcut could not be created at all on a non-CJK Windows.** `WScript.Shell` marshals
  the link path through the ANSI code page, so `DeepSeek Harness (调试模式).lnk` reached COM as
  `DeepSeek Harness (????).lnk` and `Save()` threw `FileNotFoundException` (the whole script aborted,
  which also skipped the Start Menu link). The link is now `DeepSeek Harness (Debug).lnk`, and an
  existing pre-1.1.3 Chinese-named link is migrated away via the filesystem API.
- **The Start Menu shortcut was silently skipped whenever sign-in autostart was enabled.** PowerShell
  variable names are case-insensitive, so the generated script's `$startup = [Environment]::GetFolderPath('Startup')`
  assigned a string to the script's own `[switch]$Startup` parameter and aborted the whole script —
  the two desktop links had already been created, the Start Menu link never was. The body variable is
  now `$startupDir`, and the script exports `-DesktopPath/-StartupPath/-ProgramsPath` overrides.
- **Shortcut deletion can no longer touch links this installation did not create.** Every launcher
  home now records the absolute paths it created in `shortcuts.json`; `removeShortcuts` /
  `removeInstall` delete exactly those paths (installs that predate the manifest fall back to the
  default names). This closes the hole that let a test run — which resolved the shell folders from the
  ambient profile — delete the real desktop and start-menu links.
- **Destructive helpers honour the test seam**: with `DSH_DESKTOP_TEST=1` a removal is reported
  (`wouldRemove`) instead of performed unless the caller passes `dryRun: false`.
- The manifest records the Chinese-named debug link again: it is computed from the requested folders
  and confirmed on disk instead of being parsed out of PowerShell's stdout, which PowerShell 5.1
  encoded with the OEM code page (both scripts now also force UTF-8 console output).
- `POST /api/dsh-desktop/cleanup` answers 409 when nothing is installed in that home.

### Added
- Tests: the suite now pins `USERPROFILE`/`APPDATA` to a sandbox (and asserts the shell folders stay
  inside it), runs the **real PowerShell script** against sandbox folders with `spawnRunner` and
  checks the four links plus the manifest, covers the dry-run seam and the manifest-scoped deletion.
  50 → 57 checks.

## [1.1.2] — 2026-09-15

### Fixed
- **Settings row layout inside the narrow settings column.** The six-button control group was pinned
  with `flexShrink: 0`, so it kept its max-content width: it overflowed the column (the last button
  rendered outside the panel) and squeezed the label column to zero width, printing the title and the
  description one character per line. The row now wraps (`flex-wrap: wrap`, the label column keeps a
  `1 1 260px` basis, the control group is `0 1 auto` and wraps its own buttons), buttons never break
  inside their own label (`white-space: nowrap`), and the destructive action sits last.

### Changed
- The status block renders one fact per line instead of a single `·`-joined sentence, and the long
  behaviour notes are collapsed behind a 「行为说明（点击展开）」 / "Behaviour notes (click to expand)"
  disclosure so the row stays compact.
- Shorter button labels (「安装 / 修复」「调试重启」 / "Install / repair", "Debug restart") keep the
  group to two rows at the default settings width.

### Added
- A layout regression test pins the row contract (`LAYOUT`), which is exactly what failed here: the
  row wraps, the control group shrinks, buttons stay `nowrap`. 49 → 50 checks.

## [1.1.1] — 2026-09-14

Polish pass over the 1.1.0 settings row and documentation.

### Fixed
- **Management actions are disabled until the shell is installed.** Rebuild-shortcuts, the autostart
  switch, removal and both restart buttons used to be clickable on a machine where nothing was
  installed, so clicking "enable sign-in autostart" created a Startup shortcut pointing at a missing
  exe. The host half now also answers 409 for `POST /api/dsh-desktop/autostart {enabled:true}` and for
  `POST /api/dsh-desktop/shortcuts` in that state, so a raw API call cannot arm autostart or write
  shortcuts for a launcher that does not exist.
- **The autostart switch understands a leftover Startup shortcut.** An install upgraded from 1.0.x has
  the shortcut but no preference yet; the row used to show "off" while the shortcut was still there,
  and the button offered "enable" instead of "disable". A shortcut now counts as ON, so one click
  removes it.

### Changed
- Documentation (README zh/en, in-row hint): 「清理安装」 / "Remove installation" also deletes the saved
  WebView2 session (the next desktop launch signs in again), and the launcher home is re-provisioned
  on the next host start while the plugin stays installed — uninstall the plugin (or set
  `DSH_DESKTOP_NO_AUTOINSTALL=1`) when the removal has to stick.

### Added
- Browser-half tests: the bundle is loaded through a stub `window.__ModuleLoader__`, pinning the module
  id, zh/en dictionary parity, the `settings.general.item` registration and the new action-gating
  helpers. A package-identity assertion now also pins `lib/install.js` `VERSION` to
  `package.json`'s version (it had drifted to the previous release). 40 → 49 checks.

## [1.1.0] — 2026-09-13

Review follow-up: the desktop shell no longer arms sign-in autostart by default, and everything it
creates can be removed from the settings row.

### Changed
- **Sign-in autostart is opt-in.** Installing/repairing now creates the desktop, debug and start-menu
  shortcuts only; the Startup-folder shortcut appears after the user enables 登录自启 /
  "sign-in autostart" in 设置 → 通用设置 → DSH 桌面外壳. The choice is persisted in
  `<home>\preferences.json` (`{"autostart": false}` by default; an unreadable file always resolves to
  off, so autostart can never re-arm by accident). Turning the switch off deletes the shortcut.
- **Removal is a first-class action.** The settings row gained 清理安装 / "Remove installation":
  it deletes every shortcut this plugin created plus the launcher home
  (`POST /api/dsh-desktop/cleanup`). It refuses while the launcher is running (the exe is locked) and
  asks the user to exit from the tray menu first. Unloading the plugin still deletes nothing by
  itself — the host can be restarted by the launcher at any moment, so automatic removal would risk
  deleting files that are in use.
- New loopback routes: `POST /api/dsh-desktop/autostart` (`{enabled:boolean}`) and
  `POST /api/dsh-desktop/cleanup` (`{force?:boolean}`); `GET /api/dsh-desktop/status` now also reports
  `preferences` and `launcherRunning`.
- The Edge-PWA backup shortcut (`… (Edge 应用).lnk`) is explicitly excluded from every cleanup path.

### Added
- `SHA256SUMS.txt` (+ generator `assets/build-checksums.mjs`): the prebuilt launcher, the WebView2
  DLLs and both icons are pinned by SHA-256, and the test suite re-verifies the manifest against the
  packaged bytes so it cannot drift from the published binaries.
- README sections 行为与安全说明 / "Behaviour & safety" (Windows-only, install path incl. the WebView2
  DLLs, which shortcuts are created, opt-in autostart, the `taskkill /T /F` restart fallback,
  loopback-only routes) and 可复现构建与哈希 / "Reproducible build & hashes" (rebuild command for the
  prebuilt exe).
- Tests: 27 → 40 checks (new `[autostart]`, cleanup, route validation and checksum sections).

### Notes
- The launcher itself (`DSHLauncher.exe` / `DSHLauncher.cs`) is unchanged in this release.

## [1.0.1] — 2026-09-13

Packaging-only release: the npm pipeline now uses npm trusted publishing.

### Changed
- `.github/workflows/publish.yml` publishes through npm **trusted publishing (OIDC)** — no
  `NPM_TOKEN` secret is stored in the repository, and provenance is generated by npm for OIDC
  publishes. The job fails fast when the npm CLI is older than 11.5.1, or when the pushed tag
  does not match the `package.json` version.

### Notes
- No runtime change: the launcher, host half and browser half are identical to 1.0.0.

## [1.0.0] — 2026-09-13

First release: turn the DeepSeek Harness Web UI into a native desktop application from inside DSH.

### Added
- **Host half** — provisions the desktop shell on activation (default `%USERPROFILE%\dsh-desktop`),
  generates `launcher.config.json` from live host facts, and exposes loopback routes
  `GET /api/dsh-desktop/status`, `POST /api/dsh-desktop/{install,shortcuts,restart}`.
- **Browser half** — one row in 设置 → 通用设置 (`DSH desktop shell`) with install/repair,
  rebuild-shortcuts, restart and debug-restart, plus live status.
- **Portable launcher** (shipped prebuilt, x64, .NET Framework 4.8):
  WebView2 window, close-to-tray with tray-only exit, silent backend start with logging,
  readiness gating on the backend's process-token line, automatic `--no-open`,
  debug mode in a visible console, external-backend takeover, and a restart watchdog with backoff.
- **Shortcuts** — desktop (main + debug), Startup and Start Menu; an existing Edge PWA shortcut is
  preserved by renaming it to `DeepSeek Harness (Edge 应用)`.
- **Safe replacement** of a launcher exe that is currently running (rename-swap fallback).
- **Tests** — 27 checks covering config resolution, install, lock fallback, shortcut script,
  restart helper, host routes and the package-identity invariant.
- CI (Windows, Node 22/24) and a tag-driven npm publish workflow with provenance.

### Notes
- Zero runtime dependencies; the only external requirement is the WebView2 Runtime, which ships
  with current Windows.
- Windows-only for now (`dsh.client.platform: web`, launcher is a Windows executable).

[1.0.0]: https://github.com/RINGOLINK/dsh-desktop-shell/releases/tag/v1.0.0
[1.0.1]: https://github.com/RINGOLINK/dsh-desktop-shell/releases/tag/v1.0.1
[1.1.0]: https://github.com/RINGOLINK/dsh-desktop-shell/releases/tag/v1.1.0
[1.1.1]: https://github.com/RINGOLINK/dsh-desktop-shell/releases/tag/v1.1.1
[1.1.2]: https://github.com/RINGOLINK/dsh-desktop-shell/releases/tag/v1.1.2
[1.1.3]: https://github.com/RINGOLINK/dsh-desktop-shell/releases/tag/v1.1.3
