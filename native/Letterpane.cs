using System;
using System.IO;
using System.Drawing;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class ReadyInfo {
    public string url { get; set; }
    public string origin { get; set; }
    public bool demo { get; set; }
    public string language { get; set; }
    public string theme { get; set; }
}

internal sealed class LetterpaneWindow : Form {
    private Process service;
    private WebView2 web;
    private string allowedOrigin;
    private bool shuttingDown;
    private readonly bool demo;
    private readonly bool portable = Environment.GetEnvironmentVariable("POSTA_PORTABLE_MODE") == "1";
    private readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    private readonly string dataRoot = Path.GetFullPath(Environment.GetEnvironmentVariable("POSTA_DATA_DIR") ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".data"));
    private readonly Label loading;

    public LetterpaneWindow(bool demoMode) {
        demo = demoMode;
        Text = (portable ? "Letterpane Portable" : "Letterpane") + (demo ? NativeText.Get("native.demo") : "");
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1320, 860);
        MinimumSize = new Size(970, 650);
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = NativeTheme.Background;
        Font = new Font("Segoe UI", 10);
        var iconPath = Path.Combine(root, "Letterpane.ico");
        if (File.Exists(iconPath)) Icon = new Icon(iconPath);
        loading = new Label { Dock = DockStyle.Fill, Text = NativeText.Get("native.loading"), TextAlign = ContentAlignment.MiddleCenter, ForeColor = NativeTheme.Foreground, Font = new Font("Segoe UI", 15) };
        Controls.Add(loading);
        Load += async delegate { await StartService(); };
        FormClosing += OnClosing;
    }

    private async Task StartService() {
        try {
            var node = Path.Combine(root, "runtime", "node.exe");
            var script = Path.Combine(root, "src", "server.mjs");
            if (!File.Exists(node) || !File.Exists(script)) throw new Exception(NativeText.Get("native.missingFiles"));
            service = new Process();
            service.StartInfo = new ProcessStartInfo {
                FileName = node,
                Arguments = "\"" + script + "\" --native" + (demo ? " --demo" : ""),
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            service.StartInfo.EnvironmentVariables["POSTA_LANG"] = NativeText.Language;
            service.StartInfo.EnvironmentVariables["POSTA_THEME"] = NativeTheme.Theme;
            string startupError = null;
            service.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) {
                if (args.Data != null && args.Data.StartsWith("POSTA_ERROR:", StringComparison.Ordinal)) startupError = args.Data.Substring(12);
            };
            service.Start();
            service.BeginErrorReadLine();
            var readyTask = service.StandardOutput.ReadLineAsync();
            if (await Task.WhenAny(readyTask, Task.Delay(30000)) != readyTask) throw new Exception(NativeText.Get("native.startupTimeout"));
            var line = await readyTask;
            if (line == null || !line.StartsWith("POSTA_READY:", StringComparison.Ordinal)) {
                await Task.Delay(150);
                throw new Exception(startupError ?? NativeText.Get("native.serviceFailed"));
            }
            var info = new JavaScriptSerializer().Deserialize<ReadyInfo>(line.Substring(12));
            NativeText.Use(info.language);
            NativeTheme.Use(info.theme);
            BackColor = NativeTheme.Background;
            loading.ForeColor = NativeTheme.Foreground;
            loading.Text = NativeText.Get("native.loading");
            allowedOrigin = info.origin;
            service.EnableRaisingEvents = true;
            service.Exited += delegate {
                if (!shuttingDown && IsHandleCreated) BeginInvoke((Action)delegate {
                    if (!shuttingDown) MessageBox.Show(this, NativeText.Get("native.serviceStopped"), "Letterpane", MessageBoxButtons.OK, MessageBoxIcon.Information);
                });
            };
            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = NativeTheme.Background };
            Controls.Add(web);
            loading.BringToFront();
            var profile = Path.Combine(dataRoot, demo ? "webview-demo" : "webview-profile");
            var environment = await CoreWebView2Environment.CreateAsync(null, profile);
            await web.EnsureCoreWebView2Async(environment);
            web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            web.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
            web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            web.CoreWebView2.Settings.IsPasswordAutosaveEnabled = false;
            web.CoreWebView2.Settings.IsGeneralAutofillEnabled = false;
            web.CoreWebView2.Settings.IsWebMessageEnabled = false;
            web.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args) {
                Uri uri;
                if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out uri) || uri.GetLeftPart(UriPartial.Authority) != allowedOrigin) args.Cancel = true;
            };
            web.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args) { args.Handled = true; };
            web.CoreWebView2.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs args) {
                args.State = args.PermissionKind == CoreWebView2PermissionKind.ClipboardRead ? CoreWebView2PermissionState.Default : CoreWebView2PermissionState.Deny;
            };
            web.CoreWebView2.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs args) { args.Cancel = true; };
            web.CoreWebView2.DocumentTitleChanged += delegate {
                string title = web.CoreWebView2.DocumentTitle;
                if (title == "Letterpane — Mail") NativeText.Use("en");
                else if (title == "Letterpane — Пошта") NativeText.Use("uk");
                else if (title == "Letterpane — Почта") NativeText.Use("ru");
                Text = (portable ? "Letterpane Portable" : "Letterpane") + (demo ? NativeText.Get("native.demo") : "");
            };
            web.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs args) {
                if (shuttingDown || loading.IsDisposed) return;
                if (!args.IsSuccess) {
                    MessageBox.Show(this, NativeText.Get("native.windowFailed"), "Letterpane", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    Close();
                    return;
                }
                Controls.Remove(loading);
                loading.Dispose();
                web.BringToFront();
                web.Focus();
            };
            web.Source = new Uri(info.url);
        } catch (WebView2RuntimeNotFoundException) {
            MessageBox.Show(this, NativeText.Get("native.webviewMissing"), NativeText.Get("native.webviewTitle"), MessageBoxButtons.OK, MessageBoxIcon.Information);
            Close();
        } catch (Exception error) {
            // No raw process output, credentials, or mail are included in error dialogs.
            var known = error.GetType() == typeof(Exception) ? error.Message : NativeText.Get("native.windowFailed");
            MessageBox.Show(this, known, "Letterpane", MessageBoxButtons.OK, MessageBoxIcon.Information);
            Close();
        }
    }

    private async void OnClosing(object sender, FormClosingEventArgs args) {
        if (shuttingDown) return;
        args.Cancel = true;
        shuttingDown = true;
        Hide();
        if (web != null) web.Dispose();
        if (service != null) {
            try {
                if (!service.HasExited) {
                    service.StandardInput.Close();
                    await Task.Run(delegate { if (!service.WaitForExit(5000)) service.Kill(); });
                }
            } catch { }
            service.Dispose();
        }
        Close();
    }
}

internal static class Program {
    [STAThread]
    private static void Main(string[] args) {
        bool demo = Array.IndexOf(args, "--demo") >= 0 || String.Equals(Path.GetFileNameWithoutExtension(Application.ExecutablePath), "Letterpane Demo", StringComparison.OrdinalIgnoreCase);
        string root = Path.GetFullPath(Environment.GetEnvironmentVariable("POSTA_DATA_DIR") ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".data")).ToLowerInvariant();
        NativeText.Initialize(root);
        NativeTheme.Initialize(root);
        string suffix;
        using (var hash = SHA256.Create()) suffix = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(root))).Replace("-", "").Substring(0, 20);
        using (var mutex = new Mutex(false, "Local\\Posta-" + suffix + (demo ? "-demo" : ""))) {
            bool ownsMutex;
            try { ownsMutex = mutex.WaitOne(0, false); }
            catch (AbandonedMutexException) { ownsMutex = true; }
            if (!ownsMutex) { MessageBox.Show(NativeText.Get("native.running"), "Letterpane", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LetterpaneWindow(demo));
            mutex.ReleaseMutex();
        }
    }
}
