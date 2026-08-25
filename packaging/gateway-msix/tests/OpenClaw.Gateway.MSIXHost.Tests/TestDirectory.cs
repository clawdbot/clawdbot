namespace OpenClaw.MSIXHost.Tests;

internal static class TestDirectory
{
    public static string Create()
    {
        string path = Path.Combine(
            Path.GetTempPath(),
            $"openclaw-msix-host-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
    }
}
