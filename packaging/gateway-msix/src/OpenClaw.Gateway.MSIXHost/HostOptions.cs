using System.Runtime.InteropServices;

namespace OpenClaw.MSIXHost;

public sealed record HostOptions(
    string PayloadPath,
    string MetadataPath,
    string NodePath,
    string InstallDirectory,
    IReadOnlyList<string> OpenClawArguments)
{
    public static HostOptions Parse(IReadOnlyList<string> arguments)
    {
        string architecture = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "x64",
            Architecture.Arm64 => "arm64",
            _ => throw new PlatformNotSupportedException(
                $"Unsupported process architecture: {RuntimeInformation.ProcessArchitecture}.")
        };

        string payloadDirectory = Path.Combine(AppContext.BaseDirectory, "payload");
        string payloadPath = Path.Combine(payloadDirectory, $"app-{architecture}.tar.gz");
        string metadataPath = Path.Combine(payloadDirectory, "payload-metadata.json");
        string packagedNodePath = Path.Combine(AppContext.BaseDirectory, "runtime", "node.exe");
        string nodePath = File.Exists(packagedNodePath) ? packagedNodePath : "node";
        string userProfile = Environment.GetFolderPath(
            Environment.SpecialFolder.UserProfile);
        string installDirectory = Path.Combine(
            userProfile,
            ".openclaw-msix",
            "app");

        return new HostOptions(
            payloadPath,
            metadataPath,
            nodePath,
            installDirectory,
            arguments.ToArray());
    }
}
