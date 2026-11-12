using System;
using System.IO;
using System.Globalization;
using System.Text;

internal static class NativeText {
    private static string language = "en";
    internal static string Language { get { return language; } }
    internal static void Use(string value) {
        if (value == "ru" || value == "en" || value == "uk") language = value;
    }
    internal static void Initialize(string profileRoot) {
        Use(CultureInfo.CurrentUICulture.TwoLetterISOLanguageName);
        Use(Environment.GetEnvironmentVariable("POSTA_LANG"));
        try {
            string path = Path.Combine(profileRoot, "ui-language");
            if (File.Exists(path) && new FileInfo(path).Length <= 16) Use(File.ReadAllText(path, Encoding.UTF8).Trim());
        } catch { }
    }
    internal static string Get(string key) {
        string value;
        if (NativeCatalog.Values[language].TryGetValue(key, out value)) return value;
        return NativeCatalog.Values["en"].TryGetValue(key, out value) ? value : "Letterpane";
    }
}
