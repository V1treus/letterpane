using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Drawing;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

// This executable is an additional single-file distribution. It never modifies
// the existing folder distribution and never embeds a user's .data profile.
internal static class PortableProgram {
    internal static readonly string TempRoot = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "LetterpanePortable"));
    internal static readonly string ProfileRoot = ResolveProfileRoot(AppDomain.CurrentDomain.BaseDirectory);

    internal static string ResolveProfileRoot(string directory) {
        string current = Path.Combine(directory, "Letterpane Portable.data");
        string previous = Path.Combine(directory, "Posta Portable.data");
        if (!Directory.Exists(current) && !File.Exists(current) && Directory.Exists(previous)) return previous;
        return current;
    }

    [STAThread]
    private static void Main(string[] args) {
        NativeText.Initialize(ProfileRoot);
        NativeTheme.Initialize(ProfileRoot);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new PortableWindow(Array.IndexOf(args, "--demo") >= 0));
    }

    internal static void CheckContained(string path) {
        string full = Path.GetFullPath(path);
        string prefix = TempRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new IOException("Invalid runtime cache path");
    }

    private static bool CacheReady(string directory) {
        CheckContained(directory);
        try {
            if (File.ReadAllText(Path.Combine(directory, ".complete")) != PortablePayload.Sha256) return false;
            using (var input = Assembly.GetExecutingAssembly().GetManifestResourceStream("Letterpane.Payload.zip"))
            using (var archive = new ZipArchive(input, ZipArchiveMode.Read)) {
                foreach (var entry in archive.Entries) {
                    if (String.IsNullOrEmpty(entry.Name)) continue;
                    string target = SafeEntryPath(directory, entry.FullName);
                    var file = new FileInfo(target);
                    if (!file.Exists || file.Length != entry.Length) return false;
                }
            }
            return true;
        } catch { return false; }
    }

    private static string SafeEntryPath(string directory, string name) {
        if (name.IndexOf(':') >= 0 || Path.IsPathRooted(name)) throw new IOException("Invalid embedded file path");
        string target = Path.GetFullPath(Path.Combine(directory, name.Replace('/', Path.DirectorySeparatorChar)));
        if (!target.StartsWith(Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("Invalid embedded file path");
        CheckContained(target);
        return target;
    }

    internal static string PrepareRuntime() {
        Directory.CreateDirectory(TempRoot);
        using (var mutex = new Mutex(false, "Local\\LetterpanePortable-" + PortablePayload.Sha256.Substring(0, 24))) {
            bool owns = false;
            try {
                try { owns = mutex.WaitOne(120000, false); } catch (AbandonedMutexException) { owns = true; }
                if (!owns) throw new IOException("Runtime preparation timeout");
                string destination = Path.Combine(TempRoot, PortablePayload.Sha256);
                if (CacheReady(destination)) return destination;
                // Never overwrite a runtime potentially being used by another window.
                if (Directory.Exists(destination)) destination += "-" + Guid.NewGuid().ToString("N");
                string staging = Path.Combine(TempRoot, ".stage-" + Guid.NewGuid().ToString("N"));
                CheckContained(staging); CheckContained(destination);
                Directory.CreateDirectory(staging);
                try {
                    using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("Letterpane.Payload.zip")) {
                        if (payload == null) throw new IOException("Missing embedded payload");
                        using (var sha = SHA256.Create()) {
                            string hash = BitConverter.ToString(sha.ComputeHash(payload)).Replace("-", "");
                            if (!String.Equals(hash, PortablePayload.Sha256, StringComparison.OrdinalIgnoreCase)) throw new IOException("Embedded payload integrity check failed");
                        }
                        payload.Position = 0;
                        using (var archive = new ZipArchive(payload, ZipArchiveMode.Read)) {
                            foreach (var entry in archive.Entries) {
                                if (String.IsNullOrEmpty(entry.Name)) continue;
                                // The release builder also verifies that no profile is in the payload.
                                if (entry.FullName.StartsWith(".data/", StringComparison.OrdinalIgnoreCase)) throw new IOException("Unexpected profile in payload");
                                string target = SafeEntryPath(staging, entry.FullName);
                                Directory.CreateDirectory(Path.GetDirectoryName(target));
                                using (var input = entry.Open())
                                using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None)) input.CopyTo(output);
                            }
                        }
                    }
                    File.WriteAllText(Path.Combine(staging, ".complete"), PortablePayload.Sha256, Encoding.ASCII);
                    // Both recursive-move targets are checked against the fixed temporary root.
                    CheckContained(staging); CheckContained(destination);
                    Directory.Move(staging, destination);
                    return destination;
                } finally {
                    // Only remove a staging directory created by this invocation.
                    CheckContained(staging);
                    if (Path.GetFileName(staging).StartsWith(".stage-", StringComparison.Ordinal) && Directory.Exists(staging)) {
                        try { Directory.Delete(staging, true); } catch { }
                    }
                }
            } finally { if (owns) mutex.ReleaseMutex(); }
        }
    }
}

internal sealed class PortableWindow : Form {
    private readonly bool demo;
    private readonly Label label;
    private bool running;

    internal PortableWindow(bool demoMode) {
        demo = demoMode;
        Text = "Letterpane Portable";
        Size = new Size(440, 230);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        MinimizeBox = false;
        BackColor = NativeTheme.Background;
        using (var ownIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath)) Icon = (Icon)ownIcon.Clone();
        label = new Label { Dock = DockStyle.Fill, Text = NativeText.Get("native.preparing"), TextAlign = ContentAlignment.MiddleCenter, ForeColor = NativeTheme.Foreground, Font = new Font("Segoe UI", 11) };
        Controls.Add(label);
        Load += async delegate { await Launch(); };
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (running) e.Cancel = true; };
    }

    private async Task Launch() {
        running = true;
        try {
            Directory.CreateDirectory(PortableProgram.ProfileRoot);
            string runtime = await Task.Run((Func<string>)PortableProgram.PrepareRuntime);
            var start = new ProcessStartInfo {
                FileName = Path.Combine(runtime, "Letterpane.exe"),
                Arguments = demo ? "--demo" : "",
                WorkingDirectory = runtime,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            start.EnvironmentVariables["POSTA_DATA_DIR"] = PortableProgram.ProfileRoot;
            start.EnvironmentVariables["POSTA_PORTABLE_MODE"] = "1";
            start.EnvironmentVariables["POSTA_DEV_URL"] = "0";
            start.EnvironmentVariables["POSTA_LANG"] = NativeText.Language;
            using (var application = Process.Start(start)) {
                Hide();
                await Task.Run(delegate { application.WaitForExit(); });
            }
        } catch {
            MessageBox.Show(this, NativeText.Get("native.portableFailed") + PortableProgram.ProfileRoot, "Letterpane Portable", MessageBoxButtons.OK, MessageBoxIcon.Information);
        } finally { running = false; Close(); }
    }
}
