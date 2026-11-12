using System;
using System.IO;
using System.Drawing;
using System.Text;
using Microsoft.Win32;

internal static class NativeTheme {
    private static string theme = "system";
    internal static string Theme { get { return theme; } }
    internal static void Use(string value) {
        if (value == "system" || (value != null && NativeThemeCatalog.Values.ContainsKey(value))) theme = value;
    }
    internal static void Initialize(string profileRoot) {
        try {
            string path = Path.Combine(profileRoot, "ui-theme");
            if (File.Exists(path) && new FileInfo(path).Length <= 16) Use(File.ReadAllText(path, Encoding.UTF8).Trim());
        } catch { }
    }
    private static string ResolvedTheme {
        get {
            if (theme != "system") return theme;
            try {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")) {
                    if (key != null && Object.Equals(key.GetValue("AppsUseLightTheme"), 0)) return "dark";
                }
            } catch { }
            return "light";
        }
    }
    internal static Color Background { get { return NativeThemeCatalog.Values[ResolvedTheme][0]; } }
    internal static Color Foreground { get { return NativeThemeCatalog.Values[ResolvedTheme][1]; } }
}
