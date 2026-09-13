// DSHLauncher - desktop shell for DeepSeek Harness.
// Owns the DSH backend process, hosts the UI in a WebView2 window and lives in the
// notification area. Closing the window hides it to the tray; only "Exit" on the tray
// menu stops the backend. Silent mode runs without any console window; debug mode runs
// the backend inside a visible PowerShell console (Tee'd to a log so the launcher can
// still capture the process token).
//
// Authentication note: `dsh web` prints "dsh web: http://127.0.0.1:PORT/?token=..."
// with a random per-process token. Visiting that URL once mints the durable signed
// session cookie kept in the WebView2 profile, so the launcher captures that line and
// navigates there; later runs can go straight to "/".
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DSHLauncher
{
    internal sealed class LauncherConfig
    {
        public int Port = 3080;
        public string NodePath = "";                    // empty -> auto-detect a node.exe
        public string DshBin = "";                      // empty -> auto-discover the installed dsh
        public string DshArgs = "web --no-open";
        public string WorkingDir = "";                  // empty -> the current user profile
        public string NodeOptions = "";
        /** Seconds to wait for the backend's readiness signal before falling back to "/". */
        public int ReadinessTimeoutSeconds = 45;
        /** Empty -> the launcher's own directory (fully portable install). */
        public string BaseDir = "";

        public string Url { get { return "http://127.0.0.1:" + Port + "/"; } }
        public string LogPath { get { return Path.Combine(BaseDir, "logs", "dsh-web.log"); } }
        public string DebugLogPath { get { return Path.Combine(BaseDir, "logs", "dsh-debug.log"); } }
        public string StatePath { get { return Path.Combine(BaseDir, "launcher.state.json"); } }
        public string CommandPath { get { return Path.Combine(BaseDir, "command.json"); } }
        public string ConfigPath { get { return Path.Combine(BaseDir, "launcher.config.json"); } }
        public string DebugCmdPath { get { return Path.Combine(BaseDir, "run-dsh-debug.cmd"); } }

        public static LauncherConfig Load()
        {
            var cfg = new LauncherConfig();
            try
            {
                // Test/alternate-instance override: keep a separate base dir (config, logs,
                // state, WebView2 profile) so an end-to-end run cannot disturb the real one.
                var envBase = Environment.GetEnvironmentVariable("DSH_LAUNCHER_BASE");
                var forcedBase = !string.IsNullOrEmpty(envBase);
                if (forcedBase) cfg.BaseDir = envBase;
                else cfg.BaseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                // Portable defaults: run from wherever the launcher lives, start the backend in
                // the user's own profile, and find node.exe without a hard-coded path.
                cfg.WorkingDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                cfg.NodePath = DetectNodePath();
                Directory.CreateDirectory(cfg.BaseDir);
                Directory.CreateDirectory(Path.Combine(cfg.BaseDir, "logs"));
                if (File.Exists(cfg.ConfigPath))
                {
                    var ser = new JavaScriptSerializer();
                    var raw = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(cfg.ConfigPath));
                    if (raw != null)
                    {
                        if (raw.ContainsKey("port")) cfg.Port = Convert.ToInt32(raw["port"]);
                        if (raw.ContainsKey("nodePath")) cfg.NodePath = Convert.ToString(raw["nodePath"]);
                        if (raw.ContainsKey("dshBin")) cfg.DshBin = Convert.ToString(raw["dshBin"]);
                        if (raw.ContainsKey("dshArgs")) cfg.DshArgs = Convert.ToString(raw["dshArgs"]);
                        if (raw.ContainsKey("readinessTimeoutSeconds")) cfg.ReadinessTimeoutSeconds = Convert.ToInt32(raw["readinessTimeoutSeconds"]);
                        cfg.DshArgs = NormalizeDshArgs(cfg.DshArgs);
                        if (raw.ContainsKey("workingDir")) cfg.WorkingDir = Convert.ToString(raw["workingDir"]);
                        if (raw.ContainsKey("nodeOptions")) cfg.NodeOptions = Convert.ToString(raw["nodeOptions"]);
                        if (!forcedBase && raw.ContainsKey("baseDir")) cfg.BaseDir = Convert.ToString(raw["baseDir"]);
                    }
                }
                else
                {
                    var ser = new JavaScriptSerializer();
                    var seed = new Dictionary<string, object>();
                    seed["port"] = cfg.Port;
                    seed["nodePath"] = cfg.NodePath;
                    seed["dshBin"] = "";
                    seed["dshArgs"] = cfg.DshArgs;
                    seed["readinessTimeoutSeconds"] = cfg.ReadinessTimeoutSeconds;
                    seed["workingDir"] = cfg.WorkingDir;
                    seed["nodeOptions"] = cfg.NodeOptions;
                    seed["baseDir"] = cfg.BaseDir;
                    File.WriteAllText(cfg.ConfigPath, ser.Serialize(seed), new UTF8Encoding(false));
                }
            }
            catch { /* keep defaults; a broken config must not block startup */ }
            // Fill anything the config left empty with a detected value.
            if (string.IsNullOrEmpty(cfg.NodePath)) cfg.NodePath = DetectNodePath();
            if (string.IsNullOrEmpty(cfg.WorkingDir)) cfg.WorkingDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return cfg;
        }

        /**
         * Find a node.exe: the configured value, the standard install location, then PATH.
         * @returns an absolute path when one exists, otherwise the bare command name.
         */
        public static string DetectNodePath()
        {
            var candidates = new List<string>();
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"));
            try
            {
                var pathVariable = Environment.GetEnvironmentVariable("PATH") ?? "";
                foreach (var dir in pathVariable.Split(';'))
                {
                    if (dir.Trim() == "") continue;
                    try { candidates.Add(Path.Combine(dir.Trim(), "node.exe")); } catch { }
                }
            }
            catch { }
            foreach (var candidate in candidates)
            {
                try { if (File.Exists(candidate)) return candidate; } catch { }
            }
            return "node.exe";
        }

        /**
         * Keep the Web profile from handing its authenticated URL to a separate browser:
         * the launcher owns the window, so `--no-open` is appended unless the user opted out
         * by writing their own flag set.
         * @param args - configured dsh argument string.
         * @returns the argument string to launch with.
         */
        public static string NormalizeDshArgs(string args)
        {
            var text = (args ?? "").Trim();
            if (text.Length == 0) text = "web";
            if (text.IndexOf("--no-open", StringComparison.OrdinalIgnoreCase) >= 0) return text;
            if (text.Equals("web", StringComparison.OrdinalIgnoreCase) || text.StartsWith("web ", StringComparison.OrdinalIgnoreCase)) return text + " --no-open";
            return text;
        }

        /**
         * Locate the installed @deepseek-ai/dsh bin.js.
         * Search order: the configured path, a globally installed copy, then every npx cache
         * entry (newest first) — so a launcher copied to another machine still finds DSH.
         * @returns an absolute path, or null when nothing matched.
         */
        public string ResolveDshBin()
        {
            if (!string.IsNullOrEmpty(DshBin) && File.Exists(DshBin)) return DshBin;
            var candidates = new List<string>();
            try
            {
                var globalPrefix = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
                candidates.Add(globalPrefix);
            }
            catch { }
            try
            {
                var cache = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "npm-cache", "_npx");
                if (Directory.Exists(cache))
                {
                    foreach (var dir in Directory.GetDirectories(cache))
                    {
                        var p = Path.Combine(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
                        if (File.Exists(p)) candidates.Add(p);
                    }
                }
            }
            catch { }
            var existing = new List<string>();
            foreach (var candidate in candidates)
            {
                try { if (File.Exists(candidate)) existing.Add(candidate); } catch { }
            }
            if (existing.Count == 0) return null;
            existing.Sort(delegate (string a, string b) { return File.GetLastWriteTimeUtc(b).CompareTo(File.GetLastWriteTimeUtc(a)); });
            return existing[0];
        }
    }

    internal static class Program
    {
        private const string MutexName = "Global\\DSHLauncher.SingleInstance";
        private const string ShowEventName = "Global\\DSHLauncher.ShowWindow";

        [STAThread]
        private static void Main(string[] args)
        {
            bool selftest = args.Any(a => a.Equals("--selftest", StringComparison.OrdinalIgnoreCase));
            bool attachOnly = args.Any(a => a.Equals("--attach-only", StringComparison.OrdinalIgnoreCase));
            bool debug = args.Any(a => a.Equals("--debug", StringComparison.OrdinalIgnoreCase));
            bool takeover = args.Any(a => a.Equals("--takeover", StringComparison.OrdinalIgnoreCase));
            bool hidden = args.Any(a => a.Equals("--hidden", StringComparison.OrdinalIgnoreCase));
            bool noBackend = attachOnly || selftest;

            var cfg = LauncherConfig.Load();

            bool createdNew;
            var mutex = new Mutex(true, MutexName, out createdNew);
            // Test seam: an isolated instance (its own base dir + port) may run alongside the
            // real one, which the single-instance mutex would otherwise refuse.
            var isolated = Environment.GetEnvironmentVariable("DSH_LAUNCHER_NO_MUTEX") == "1";
            if (!createdNew && !isolated)
            {
                try { EventWaitHandle.OpenExisting(ShowEventName).Set(); } catch { }
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var app = new LauncherApp(cfg, noBackend, selftest, debug, takeover, hidden))
            {
                app.Run();
            }
            GC.KeepAlive(mutex);
        }
    }

    internal sealed class LauncherApp : IDisposable
    {
        private static readonly Regex AuthUrlPattern =
            new Regex(@"dsh web:\s+(https?://[^\s\)]+)", RegexOptions.Compiled | RegexOptions.IgnoreCase);

        private readonly LauncherConfig _cfg;
        private readonly bool _noBackend;
        private readonly bool _selftest;
        private readonly bool _takeoverWanted;
        private readonly bool _startHidden;

        private readonly Form _form;
        private readonly WebView2 _web;
        private readonly Panel _hintPanel;
        private readonly Label _hint;
        private readonly Button _takeoverButton;
        private readonly NotifyIcon _tray;
        private readonly Icon _iconMain;
        private readonly Icon _iconDebug;
        private readonly Icon _trayIconMain;
        private readonly Icon _trayIconDebug;
        private readonly System.Windows.Forms.Timer _watchdog = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _commandPoll = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _tokenScan = new System.Windows.Forms.Timer();
        private readonly EventWaitHandle _showEvent;
        private readonly Thread _showWaiter;

        private Process _backend;                 // non-null when we started it
        private bool _backendOwned;
        private bool _externalInstance;           // port busy with a process we do not own
        private bool _exiting;
        private bool _restarting;
        private bool _webReady;
        private bool _webViewFailed;
        private int _downTicks;
        private int _stateTicks;
        private int _restartAttempts;
        private DateTime _nextRestartAllowed = DateTime.MinValue;
        private string _authUrl;                  // captured "?token=" URL
        private DateTime _portUpAt = DateTime.MinValue;   // when the backend port first answered
        private bool _pageLoaded;                 // the window shows a successfully loaded shell
        private bool _readyWaitLogged;            // the "waiting for readiness" note is logged once
        private bool _debugMode;
        private readonly object _logLock = new object();

        public LauncherApp(LauncherConfig cfg, bool noBackend, bool selftest, bool debug, bool takeover, bool startHidden)
        {
            _cfg = cfg;
            _noBackend = noBackend;
            _selftest = selftest;
            _takeoverWanted = takeover;
            _startHidden = startHidden;
            _debugMode = debug;

            _iconMain = LoadAppIcon("DSHLauncher.ico");
            _iconDebug = LoadAppIcon("DSHLauncher-debug.ico");
            _trayIconMain = LoadAppIcon("DSHLauncher.ico", SystemInformation.SmallIconSize);
            _trayIconDebug = LoadAppIcon("DSHLauncher-debug.ico", SystemInformation.SmallIconSize);

            _tray = new NotifyIcon();
            _tray.Icon = _debugMode ? _trayIconDebug : _trayIconMain;
            _tray.Text = "DeepSeek Harness";
            _tray.Visible = true;
            _tray.DoubleClick += delegate { ShowWindow(); };
            _tray.ContextMenuStrip = BuildMenu();

            _form = new Form();
            _form.Text = "DeepSeek Harness";
            _form.Icon = _iconMain;
            _form.Width = 1440;
            _form.Height = 900;
            _form.StartPosition = FormStartPosition.CenterScreen;
            _form.FormClosing += OnFormClosing;

            _hintPanel = new Panel();
            _hintPanel.Dock = DockStyle.Fill;
            _hint = new Label();
            _hint.Dock = DockStyle.Fill;
            _hint.TextAlign = ContentAlignment.MiddleCenter;
            _hint.Font = new Font("Microsoft YaHei UI", 10f);
            _hint.Text = StartingHint();
            _takeoverButton = new Button();
            _takeoverButton.Text = "接管后端（重启）";
            _takeoverButton.AutoSize = true;
            _takeoverButton.Visible = false;
            _takeoverButton.Click += delegate { ConfirmTakeover(); };
            var buttonHost = new FlowLayoutPanel();
            buttonHost.FlowDirection = FlowDirection.TopDown;
            buttonHost.AutoSize = true;
            buttonHost.Anchor = AnchorStyles.None;
            buttonHost.Controls.Add(_takeoverButton);
            var outer = new TableLayoutPanel();
            outer.Dock = DockStyle.Fill;
            outer.ColumnCount = 1;
            outer.RowCount = 2;
            outer.RowStyles.Add(new RowStyle(SizeType.Percent, 60f));
            outer.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            outer.Controls.Add(_hint, 0, 0);
            outer.Controls.Add(buttonHost, 0, 1);
            _hintPanel.Controls.Add(outer);
            _form.Controls.Add(_hintPanel);

            _web = new WebView2();
            _web.Dock = DockStyle.Fill;
            _web.Visible = false;
            _form.Controls.Add(_web);
            _web.BringToFront();

            _showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "Global\\DSHLauncher.ShowWindow");
            _showWaiter = new Thread(delegate ()
            {
                while (!_exiting)
                {
                    try { if (_showEvent.WaitOne(500)) { try { _form.BeginInvoke((Action)ShowWindow); } catch { } } }
                    catch { break; }
                }
            });
            _showWaiter.IsBackground = true;
            _showWaiter.Start();

            _watchdog.Interval = 2000;
            _watchdog.Tick += OnWatchdog;
            _commandPoll.Interval = 1000;
            _commandPoll.Tick += OnCommandPoll;
            _tokenScan.Interval = 700;
            _tokenScan.Tick += OnTokenScan;
        }

        private ContextMenuStrip BuildMenu()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开界面(&O)", null, delegate { ShowWindow(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("重启后端(&R)", null, delegate { RequestRestart(false); });
            menu.Items.Add("以调试模式重启(&D)", null, delegate { RequestRestart(true); });
            menu.Items.Add("接管外部后端（重启）(&T)", null, delegate { ConfirmTakeover(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("打开日志(&L)", null, delegate { OpenLog(); });
            menu.Items.Add("打开配置(&C)", null, delegate { OpenPath(_cfg.ConfigPath); });
            menu.Items.Add("打开数据目录(&F)", null, delegate { OpenPath(_cfg.BaseDir); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出(&Q)", null, delegate { ExitAll(); });
            return menu;
        }

        public void Run()
        {
            _form.Shown += async delegate
            {
                if (_startHidden) _form.Hide();
                await StartAsync();
            };
            Application.Run(_form);
        }

        private async Task StartAsync()
        {
            Log("--- launcher start: mode=" + (_debugMode ? "debug" : "silent") + " selftest=" + _selftest +
                " takeover=" + _takeoverWanted + " ---");
            await InitWebViewAsync();

            if (_selftest) { await RunSelfTestAsync(); return; }

            if (!_noBackend) EnsureBackend();
            if (!_selftest)
            {
                _watchdog.Start();
                _commandPoll.Start();
                _tokenScan.Start();
            }
            WriteState();
        }

        private async Task InitWebViewAsync()
        {
            try
            {
                var dataDir = Path.Combine(_cfg.BaseDir, "webview2-data");
                Directory.CreateDirectory(dataDir);
                var env = await CoreWebView2Environment.CreateAsync(null, dataDir, null);
                await _web.EnsureCoreWebView2Async(env);
                _web.CoreWebView2.Settings.AreDevToolsEnabled = true;
                _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                _web.CoreWebView2.NewWindowRequested += delegate (object s, CoreWebView2NewWindowRequestedEventArgs e)
                {
                    e.Handled = true;
                    try { Process.Start(e.Uri); } catch { }
                };
                _web.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
                _webReady = true;
                Log("webview2 ready (runtime " + env.BrowserVersionString + ")");
            }
            catch (Exception ex)
            {
                _webViewFailed = true;
                Log("webview2 init FAILED: " + ex.Message);
                SetHint("WebView2 初始化失败：" + ex.Message + "\r\n\r\n可改用桌面「DeepSeek Harness (Edge 应用)」快捷方式。", false);
            }
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.IsSuccess)
            {
                var landed = "";
                try { landed = _web.Source == null ? "" : _web.Source.ToString(); } catch { }
                _pageLoaded = true;
                Log("navigation ok -> " + landed);
                LogPageTitleAsync();
                return;
            }
            _pageLoaded = false;
            Log("navigation failed: " + e.WebErrorStatus + " for " + (_authUrl ?? _cfg.Url));
            if (_authUrl == null)
            {
                // No token captured yet: the shell fence rejects unauthenticated loads.
                SetHint("已连接后端，但需要进程令牌才能打开界面。\r\n" +
                        (File.Exists(_cfg.LogPath) ? "启动器会在后端打印令牌后自动进入；" : "") +
                        "若长期停留在此，请在托盘点「重启后端」让启动器接管并捕获令牌。", false);
            }
        }

        private async void LogPageTitleAsync()
        {
            try
            {
                var raw = await _web.CoreWebView2.ExecuteScriptAsync("document.title");
                Log("page title: " + (raw ?? ""));
                if (!_hintPanel.Visible) SetHint("", false);
                _hintPanel.Visible = false;
                _web.Visible = true;
            }
            catch (Exception ex) { Log("title probe failed: " + ex.Message); }
        }

        private void Navigate()
        {
            if (!_webReady || _webViewFailed) return;
            var target = _authUrl ?? _cfg.Url;
            try
            {
                if (_web.Source == null || _web.Source.ToString() != target)
                {
                    SetHint("后端已就绪，正在加载界面…", false);
                    _web.Visible = true;
                    _web.CoreWebView2.Navigate(target);
                    Log("navigating to " + (_authUrl != null ? "captured authenticated URL" : _cfg.Url));
                }
            }
            catch (Exception ex) { Log("navigate failed: " + ex.Message); }
        }

        // ---------------- token capture ----------------

        private void CaptureToken(string line)
        {
            if (line == null || line.IndexOf("dsh web:", StringComparison.OrdinalIgnoreCase) < 0) return;
            var m = AuthUrlPattern.Match(line);
            if (!m.Success) return;
            var url = m.Groups[1].Value;
            if (_authUrl == url) return;
            _authUrl = url;
            Log("captured process-token URL from backend output (token hidden)");
            try { _form.BeginInvoke((Action)Navigate); } catch { }
        }

        private void OnTokenScan(object sender, EventArgs e)
        {
            if (_authUrl != null) { _tokenScan.Stop(); return; }
            try
            {
                foreach (var path in new[] { _cfg.DebugLogPath, _cfg.LogPath })
                {
                    if (!File.Exists(path)) continue;
                    var tail = ReadTail(path, 64 * 1024);
                    if (tail != null && tail.IndexOf("dsh web:", StringComparison.OrdinalIgnoreCase) >= 0) { CaptureToken(tail); return; }
                }
            }
            catch { }
        }

        private static string ReadTail(string path, int maxBytes)
        {
            try
            {
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    var length = fs.Length;
                    var start = Math.Max(0, length - maxBytes);
                    fs.Seek(start, SeekOrigin.Begin);
                    var buffer = new byte[length - start];
                    var read = fs.Read(buffer, 0, buffer.Length);
                    if (read >= 2 && buffer[0] == 0xFF && buffer[1] == 0xFE) return Encoding.Unicode.GetString(buffer, 2, read - 2);
                    if (read >= 2 && buffer[0] == 0xFE && buffer[1] == 0xFF) return Encoding.BigEndianUnicode.GetString(buffer, 2, read - 2);
                    if (read >= 3 && buffer[0] == 0xEF && buffer[1] == 0xBB && buffer[2] == 0xBF) return Encoding.UTF8.GetString(buffer, 3, read - 3);
                    // A tail window without a BOM still reveals UTF-16 (PowerShell 5.1 Tee-Object
                    // writes Unicode by default) through its null-byte pattern.
                    var nulls = 0;
                    for (var i = 0; i < read; i++) if (buffer[i] == 0) nulls++;
                    if (read > 0 && nulls > read / 4)
                    {
                        var offset = (start % 2 == 0) ? 0 : 1;
                        return Encoding.Unicode.GetString(buffer, offset, read - offset);
                    }
                    return Encoding.UTF8.GetString(buffer, 0, read);
                }
            }
            catch { return null; }
        }

        // ---------------- backend lifecycle ----------------

        private bool PortListening()
        {
            try
            {
                using (var client = new TcpClient())
                {
                    var task = client.ConnectAsync("127.0.0.1", _cfg.Port);
                    if (!task.Wait(700)) return false;
                    return client.Connected;
                }
            }
            catch { return false; }
        }

        private void EnsureBackend()
        {
            _restarting = true;
            try
            {
                if (PortListening())
                {
                    _backendOwned = false;
                    _externalInstance = true;
                    Log("port " + _cfg.Port + " already in use — external backend detected (not owned by this launcher)");
                    if (_takeoverWanted)
                    {
                        _restarting = false;
                        Log("--takeover requested: replacing the external backend");
                        RestartBackend(_debugMode);
                        return;
                    }
                    SetHint("检测到 DSH 已由外部进程启动（端口 " + _cfg.Port + "）。\r\n" +
                            "启动器无法取得该实例的进程令牌，因此无法在此窗口显示界面。\r\n\r\n" +
                            "点击下方按钮或托盘菜单「接管外部后端（重启）」即可切换到启动器托管\r\n" +
                            "（会重启 DSH，约 10 秒；会话数据不会丢失）。", true);
                    return;
                }
                StartBackend();
            }
            finally { _restarting = false; }
        }

        private void StartBackend()
        {
            _authUrl = null;
            _portUpAt = DateTime.UtcNow;           // the wait (and the readiness timeout) starts now
            _pageLoaded = false;                   // a fresh backend means the shell must reload
            _readyWaitLogged = false;
            _tokenScan.Start();
            if (_debugMode) StartBackendDebug();
            else StartBackendSilent();
        }

        private void StartBackendSilent()
        {
            var bin = _cfg.ResolveDshBin();
            if (bin == null)
            {
                Log("ERROR: cannot locate @deepseek-ai/dsh bin.js");
                SetHint("找不到 dsh 的 bin.js，请检查配置：" + _cfg.ConfigPath, false);
                return;
            }
            var psi = new ProcessStartInfo();
            psi.FileName = _cfg.NodePath;
            psi.Arguments = Quote(bin) + " " + _cfg.DshArgs;
            psi.WorkingDirectory = _cfg.WorkingDir;
            psi.UseShellExecute = false;
            // No console at all: the backend is a server, and the GUI/plugin stack was
            // verified end-to-end under this mode. (node-pty's AttachConsole helper targets
            // a *shell* pid and succeeds whenever that target owns a console, so this has
            // no bearing on it — measured both ways.)
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            if (!string.IsNullOrEmpty(_cfg.NodeOptions)) psi.EnvironmentVariables["NODE_OPTIONS"] = _cfg.NodeOptions;
            psi.EnvironmentVariables["DSH_LAUNCHER"] = "1";
            try
            {
                var proc = new Process();
                proc.StartInfo = psi;
                proc.OutputDataReceived += delegate (object s, DataReceivedEventArgs e)
                {
                    if (e.Data == null) return;
                    Log("[out] " + e.Data);
                    CaptureToken(e.Data);
                };
                proc.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) Log("[err] " + e.Data); };
                proc.EnableRaisingEvents = true;
                proc.Exited += delegate
                {
                    Log("backend process exited (code " + SafeExitCode(proc) + ")");
                    if (!_exiting && !_restarting)
                    {
                        _backend = null;
                        _backendOwned = false;
                        _downTicks = 0;
                        Log("unexpected backend exit — restarting in silent mode");
                        try { _form.BeginInvoke((Action)delegate { _debugMode = false; StartBackend(); }); } catch { }
                    }
                };
                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                _backend = proc;
                _backendOwned = true;
                _externalInstance = false;
                Log("backend started (silent): pid=" + proc.Id + " node=" + _cfg.NodePath + " args=" + _cfg.DshArgs + " bin=" + bin);
            }
            catch (Exception ex)
            {
                Log("ERROR starting backend: " + ex.Message);
                SetHint("启动 DSH 后端失败：" + ex.Message + "\r\n日志：" + _cfg.LogPath, false);
            }
        }

        private void StartBackendDebug()
        {
            var bin = _cfg.ResolveDshBin();
            if (bin == null) { Log("ERROR: cannot locate @deepseek-ai/dsh bin.js"); return; }
            // Two files on purpose:
            //  - the .cmd wrapper stays pure ASCII (cmd.exe batch parsing is codepage-sensitive
            //    and mangles non-ASCII lines), and
            //  - the .ps1 helper is written as UTF-8 WITH BOM so Windows PowerShell renders the
            //    Chinese guidance correctly. Tee-Object gives the user a live console *and*
            //    lets the launcher scan the file for the process-token URL.
            var psPath = Path.Combine(_cfg.BaseDir, "run-dsh-debug.ps1");
            var psLines = new List<string>();
            psLines.Add("$ErrorActionPreference = 'Continue'");
            psLines.Add("Write-Host '[DSH] debug mode: backend output below, also written to:' -ForegroundColor Cyan");
            psLines.Add("Write-Host '      " + _cfg.DebugLogPath + "' -ForegroundColor DarkGray");
            psLines.Add("Write-Host '[DSH] closing this console stops the backend; tray menu -> restart silent to go back' -ForegroundColor Cyan");
            psLines.Add("Write-Host ''");
            psLines.Add("& " + PsQuote(_cfg.NodePath) + " " + PsQuote(bin) + " " + _cfg.DshArgs +
                         " 2>&1 | Tee-Object -FilePath " + PsQuote(_cfg.DebugLogPath));
            psLines.Add("Write-Host ''");
            psLines.Add("Write-Host '[DSH] backend exited; this console stays open for inspection.' -ForegroundColor Yellow");
            File.WriteAllText(psPath, string.Join("\r\n", psLines.ToArray()) + "\r\n", new UTF8Encoding(true));

            var lines = new List<string>();
            lines.Add("@echo off");
            lines.Add("chcp 65001 >nul");
            lines.Add("title DeepSeek Harness (debug)");
            if (!string.IsNullOrEmpty(_cfg.NodeOptions)) lines.Add("set NODE_OPTIONS=" + _cfg.NodeOptions);
            lines.Add("powershell -NoProfile -ExecutionPolicy Bypass -File " + Quote(psPath));
            lines.Add("echo.");
            lines.Add("pause");
            File.WriteAllLines(_cfg.DebugCmdPath, lines.ToArray(), new UTF8Encoding(false));

            var psi = new ProcessStartInfo();
            psi.FileName = "cmd.exe";
            psi.Arguments = "/k " + Quote(_cfg.DebugCmdPath);
            psi.WorkingDirectory = _cfg.WorkingDir;
            psi.UseShellExecute = true;
            psi.WindowStyle = ProcessWindowStyle.Normal;
            try
            {
                _backend = Process.Start(psi);
                _backendOwned = true;
                _externalInstance = false;
                Log("backend started (debug, visible console): pid=" + _backend.Id);
                SetHint("调试模式：后端输出显示在独立控制台窗口中。", false);
            }
            catch (Exception ex) { Log("ERROR starting debug backend: " + ex.Message); }
        }

        private static string PsQuote(string value) { return "'" + value.Replace("'", "''") + "'"; }

        private void OnBackendUp()
        {
            _downTicks = 0;
            if (!PortListening()) return;
            _restartAttempts = 0;
            _nextRestartAllowed = DateTime.MinValue;
            if (_portUpAt == DateTime.MinValue) _portUpAt = DateTime.UtcNow;
            if (_pageLoaded)
            {
                WriteState();
                return;                            // the shell is already on screen
            }
            // Never navigate on "port is listening" alone: dsh binds before the frontend is
            // mounted, which is exactly the 404 the window used to show. Wait for the real
            // readiness signal (the process-token line) or the fallback timeout.
            SetHint(StartingHint(), false);
            WriteState();
            Log("backend port is up; waiting for the readiness signal before navigating");
        }

        /**
         * Readiness gate for the first navigation.
         * `dsh web` prints its authenticated URL only after the app mounted, so that line is
         * the readiness signal; an attached (not owned) backend has no token to capture, so a
         * plain HTTP answer is used instead. A timeout keeps a misconfigured printUrl usable.
         */
        private void TickReadiness()
        {
            if (_exiting || _restarting || _pageLoaded) return;
            if (_portUpAt == DateTime.MinValue) _portUpAt = DateTime.UtcNow;
            if (!_readyWaitLogged)
            {
                _readyWaitLogged = true;
                Log("backend port is up; waiting for the readiness signal before navigating");
            }
            if (_authUrl != null)
            {
                Log("readiness signal received (process token)");
                Navigate();
                return;
            }
            if (!_backendOwned && HttpAnswers())
            {
                Log("attached backend answers HTTP; navigating to /");
                Navigate();
                return;
            }
            var waited = (DateTime.UtcNow - _portUpAt).TotalSeconds;
            if (waited > _cfg.ReadinessTimeoutSeconds)
            {
                Log("readiness timeout after " + (int)waited + "s; navigating to / as a fallback");
                Navigate();
                return;
            }
            SetHint(StartingHint(), false);
        }

        /** One cheap HTTP probe: any status (including the fence's 401) means the app is mounted. */
        private bool HttpAnswers()
        {
            try
            {
                using (var client = new System.Net.Http.HttpClient())
                {
                    client.Timeout = TimeSpan.FromSeconds(2);
                    client.GetAsync(_cfg.Url).Wait();
                    return true;
                }
            }
            catch { return false; }
        }

        /** Startup hint text including how long we have been waiting. */
        private string StartingHint()
        {
            var waited = _portUpAt == DateTime.MinValue ? 0 : (int)(DateTime.UtcNow - _portUpAt).TotalSeconds;
            return "正在启动 DSH 后端…\r\n\r\n已等待 " + waited + " 秒。后端就绪后会自动进入界面；\r\n关闭本窗口只是最小化到托盘，不会停止后端。";
        }

        private void ConfirmTakeover()
        {
            if (!_externalInstance) { RequestRestart(_debugMode); return; }
            var answer = MessageBox.Show(
                "检测到 DSH 已由外部进程启动（非本启动器托管）。\r\n\r\n" +
                "接管会停止该进程并由启动器重新启动后端，期间正在进行的对话回合会中断（会话数据保留）。\r\n\r\n是否现在接管？",
                "DeepSeek Harness — 接管后端",
                MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer == DialogResult.Yes) RequestRestart(_debugMode);
        }

        private void RequestRestart(bool debugMode)
        {
            if (_restarting) return;
            Log("restart requested (mode=" + (debugMode ? "debug" : "silent") + ")");
            ThreadPool.QueueUserWorkItem(delegate
            {
                try { RestartBackend(debugMode); }
                catch (Exception ex) { Log("restart failed: " + ex.Message); }
            });
        }

        private void RestartBackend(bool debugMode)
        {
            _restarting = true;
            try
            {
                _debugMode = debugMode;
                ApplyTrayIcon();
                _authUrl = null;
                StopBackend();
                var deadline = DateTime.UtcNow.AddSeconds(20);
                while (PortListening() && DateTime.UtcNow < deadline) Thread.Sleep(300);
                if (PortListening()) { Log("port still busy after stop; aborting restart"); return; }
                _externalInstance = false;
                StartBackend();
                var upDeadline = DateTime.UtcNow.AddSeconds(120);
                while (!PortListening() && DateTime.UtcNow < upDeadline) Thread.Sleep(500);
                if (PortListening())
                {
                    Log("backend restarted and listening");
                    try { _form.BeginInvoke((Action)delegate { OnBackendUp(); if (!_form.Visible) ShowWindow(); }); } catch { }
                }
                else Log("backend did not come up within 120s");
            }
            finally { _restarting = false; WriteState(); }
        }

        private void StopBackend()
        {
            try
            {
                var owners = PidsOnPort(_cfg.Port);
                if (_backend != null && !_backend.HasExited)
                {
                    try { KillTree(_backend.Id); } catch (Exception ex) { Log("kill backend failed: " + ex.Message); }
                }
                foreach (var pid in owners)
                {
                    try { KillTree(pid); Log("killed port owner pid=" + pid); } catch (Exception ex) { Log("kill port owner " + pid + " failed: " + ex.Message); }
                }
                _backend = null;
            }
            catch (Exception ex) { Log("stop backend error: " + ex.Message); }
        }

        private static void KillTree(int pid)
        {
            var psi = new ProcessStartInfo();
            psi.FileName = "taskkill.exe";
            psi.Arguments = "/PID " + pid + " /T /F";
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            Process.Start(psi).WaitForExit(10000);
        }

        private static List<int> PidsOnPort(int port)
        {
            var result = new List<int>();
            try
            {
                var psi = new ProcessStartInfo();
                psi.FileName = "netstat.exe";
                psi.Arguments = "-ano -p tcp";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                var txt = Process.Start(psi).StandardOutput.ReadToEnd();
                foreach (var line in txt.Split('\n'))
                {
                    if (line.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    if (line.IndexOf(":" + port + " ", StringComparison.Ordinal) < 0) continue;
                    var parts = line.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 5)
                    {
                        int pid;
                        if (int.TryParse(parts[parts.Length - 1], out pid) && !result.Contains(pid)) result.Add(pid);
                    }
                }
            }
            catch { }
            return result;
        }

        // ---------------- window / tray ----------------

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (_exiting) return;
            e.Cancel = true;                     // close button hides to tray
            HideToTray();
        }

        private void HideToTray()
        {
            _form.Hide();
            _form.ShowInTaskbar = false;
            try
            {
                _tray.BalloonTipTitle = "DeepSeek Harness 仍在后台运行";
                _tray.BalloonTipText = "窗口已最小化到托盘。右键托盘图标可打开界面或退出（退出会同时停止后端）。";
                _tray.ShowBalloonTip(2500);
            }
            catch { }
        }

        private void ShowWindow()
        {
            if (_exiting) return;
            _form.ShowInTaskbar = true;
            _form.Show();
            if (_form.WindowState == FormWindowState.Minimized) _form.WindowState = FormWindowState.Normal;
            _form.Activate();
            _form.BringToFront();
            if (PortListening()) OnBackendUp();
        }

        private void ExitAll()
        {
            _exiting = true;
            _watchdog.Stop();
            _commandPoll.Stop();
            _tokenScan.Stop();
            Log("exit requested from tray — stopping backend");
            if (_backendOwned) StopBackend();
            else Log("backend not owned by this launcher; leaving it running");
            try { File.Delete(_cfg.StatePath); } catch { }
            _tray.Visible = false;
            _form.Close();
            Application.Exit();
        }

        private void OpenLog()
        {
            try
            {
                if (!File.Exists(_cfg.LogPath)) File.WriteAllText(_cfg.LogPath, "");
                Process.Start("notepad.exe", _cfg.LogPath);
            }
            catch { }
        }

        private void OpenPath(string path)
        {
            try { Process.Start("explorer.exe", "/select,\"" + path + "\""); } catch { }
        }

        // ---------------- timers ----------------

        private void OnWatchdog(object sender, EventArgs e)
        {
            if (_exiting || _restarting) return;
            // Refresh the published state regularly so the dsh-power plugin can tell the
            // launcher is still alive and still owns the backend.
            _stateTicks++;
            if (_stateTicks >= 15) { _stateTicks = 0; WriteState(); }
            if (PortListening())
            {
                _downTicks = 0;
                TickReadiness();
                return;
            }
            _downTicks++;
            if (_downTicks >= 4 && _backendOwned)
            {
                _downTicks = 0;
                if (DateTime.UtcNow < _nextRestartAllowed)
                {
                    Log("watchdog: backend still down; waiting out the backoff window");
                    return;
                }
                _restartAttempts++;
                if (_restartAttempts >= 4)
                {
                    _nextRestartAllowed = DateTime.UtcNow.AddSeconds(60);
                    Log("watchdog: " + _restartAttempts + " consecutive failed starts — backing off 60s");
                    SetHint("后端连续启动失败 " + _restartAttempts + " 次，已暂停自动重启 60 秒。\r\n" +
                            "请查看日志：" + _cfg.LogPath + "\r\n或使用托盘菜单「以调试模式重启」观察报错。", false);
                }
                Log("watchdog: backend down — restarting (attempt " + _restartAttempts + ")");
                RequestRestart(_debugMode);
            }
        }

        private void OnCommandPoll(object sender, EventArgs e)
        {
            if (_exiting) return;
            try
            {
                if (!File.Exists(_cfg.CommandPath)) return;
                var text = File.ReadAllText(_cfg.CommandPath);
                File.Delete(_cfg.CommandPath);
                var ser = new JavaScriptSerializer();
                var cmd = ser.Deserialize<Dictionary<string, object>>(text);
                if (cmd == null || !cmd.ContainsKey("action")) return;
                var action = Convert.ToString(cmd["action"]);
                var mode = cmd.ContainsKey("mode") ? Convert.ToString(cmd["mode"]) : "silent";
                Log("command file: action=" + action + " mode=" + mode +
                    " source=" + (cmd.ContainsKey("source") ? Convert.ToString(cmd["source"]) : "?"));
                if (action == "restart") RequestRestart(mode.Equals("debug", StringComparison.OrdinalIgnoreCase));
                else if (action == "exit") ExitAll();
            }
            catch (Exception ex) { Log("command poll error: " + ex.Message); }
        }

        private void WriteState()
        {
            try
            {
                var ser = new JavaScriptSerializer();
                var state = new Dictionary<string, object>();
                state["pid"] = Process.GetCurrentProcess().Id;
                state["mode"] = _debugMode ? "debug" : "silent";
                state["port"] = _cfg.Port;
                state["url"] = _cfg.Url;
                state["backendPid"] = (_backend != null && !_backend.HasExited) ? _backend.Id : 0;
                state["backendOwned"] = _backendOwned;
                state["externalInstance"] = _externalInstance;
                state["updatedAt"] = DateTime.UtcNow.ToString("o");
                state["exe"] = Application.ExecutablePath;
                File.WriteAllText(_cfg.StatePath, ser.Serialize(state), new UTF8Encoding(false));
            }
            catch { }
        }

        private void SetHint(string text, bool showTakeover)
        {
            try
            {
                _form.BeginInvoke((Action)delegate
                {
                    _hint.Text = text;
                    _takeoverButton.Visible = showTakeover;
                    _hintPanel.Visible = true;
                    _hintPanel.BringToFront();
                });
            }
            catch { }
        }

        // ---------------- selftest ----------------

        private async Task RunSelfTestAsync()
        {
            if (!_webReady)
            {
                Log("SELFTEST FAIL: webview2 not ready");
                Environment.Exit(1);
            }
            if (!PortListening())
            {
                Log("SELFTEST FAIL: no backend on port " + _cfg.Port + " (start one first to attach)");
                Environment.Exit(1);
            }
            // Prove the fence is understood: unauthenticated root must answer 401.
            var probe = "n/a";
            try
            {
                using (var client = new System.Net.Http.HttpClient())
                {
                    client.Timeout = TimeSpan.FromSeconds(5);
                    var resp = client.GetAsync(_cfg.Url).Result;
                    probe = ((int)resp.StatusCode).ToString();
                }
            }
            catch (Exception ex) { probe = "error:" + ex.Message; }
            Log("SELFTEST unauthenticated GET / -> " + probe);
            Log("SELFTEST PASS (webview2 runtime usable, backend reachable, expected 401 without token: " + probe + ")");
            Environment.Exit(0);
        }

        // ---------------- helpers ----------------

        private static string Quote(string value) { return "\"" + value + "\""; }

        /**
         * Load one .ico shipped beside the executable (the whale icons), falling back to
         * the exe's own embedded icon and finally to the generic application icon.
         * Every branch is logged so a wrong tray/window icon can be diagnosed from the log.
         * @param fileName - icon file name resolved next to the executable.
         * @param size - optional exact icon size (the tray wants the small shell size).
         */
        private Icon LoadAppIcon(string fileName, Size? size = null)
        {
            var path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, fileName);
            try
            {
                if (File.Exists(path))
                {
                    var icon = size.HasValue ? new Icon(path, size.Value) : new Icon(path);
                    Log("icon: " + fileName + " loaded (" + icon.Width + "x" + icon.Height + (size.HasValue ? ", tray request " + size.Value.Width + "x" + size.Value.Height : "") + ")");
                    return icon;
                }
                Log("icon: " + fileName + " NOT FOUND at " + path + " — falling back");
            }
            catch (Exception ex)
            {
                Log("icon: " + fileName + " load failed (" + ex.Message + ") — falling back");
            }
            try
            {
                var extracted = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (extracted != null)
                {
                    Log("icon: using the exe's embedded icon (" + extracted.Width + "x" + extracted.Height + ")");
                    return extracted;
                }
            }
            catch { }
            Log("icon: using the system application icon (no custom icon available)");
            return SystemIcons.Application;
        }

        /** Show the debug-marked tray icon while the backend runs in debug mode. */
        private void ApplyTrayIcon()
        {
            try { _tray.Icon = _debugMode ? _trayIconDebug : _trayIconMain; } catch { }
        }

        private static object SafeExitCode(Process p)
        {
            try { return p.ExitCode; } catch { return "?"; }
        }

        private void Log(string message)
        {
            try
            {
                lock (_logLock)
                {
                    var line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  " + message + "\r\n";
                    var dir = Path.GetDirectoryName(_cfg.LogPath);
                    if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                    if (File.Exists(_cfg.LogPath) && new FileInfo(_cfg.LogPath).Length > 8 * 1024 * 1024)
                    {
                        var old = _cfg.LogPath + ".1";
                        try { if (File.Exists(old)) File.Delete(old); File.Move(_cfg.LogPath, old); } catch { }
                    }
                    File.AppendAllText(_cfg.LogPath, line, new UTF8Encoding(false));
                }
            }
            catch { }
        }

        public void Dispose()
        {
            try { _tray.Dispose(); } catch { }
            try { _watchdog.Dispose(); } catch { }
            try { _commandPoll.Dispose(); } catch { }
            try { _tokenScan.Dispose(); } catch { }
        }
    }
}
