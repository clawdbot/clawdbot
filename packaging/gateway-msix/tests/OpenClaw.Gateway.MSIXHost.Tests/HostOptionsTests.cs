namespace OpenClaw.MSIXHost.Tests;

public sealed class HostOptionsTests
{
    [Fact]
    public void ParseForwardsAllArgumentsUnchanged()
    {
        HostOptions options = HostOptions.Parse(
        [
            "--host-payload", "payload.tar.gz",
            "--host-node", "test-node.exe",
            "--",
            "gateway", "run", "--port", "12345"
        ]);

        Assert.Equal(
            [
                "--host-payload", "payload.tar.gz",
                "--host-node", "test-node.exe",
                "--",
                "gateway", "run", "--port", "12345"
            ],
            options.OpenClawArguments);
    }

    [Fact]
    public void ParseUsesPackagedAndProfileDefaults()
    {
        HostOptions options = HostOptions.Parse([]);

        Assert.EndsWith(
            Path.Combine("payload", $"app-{GetArchitecture()}.tar.gz"),
            options.PayloadPath,
            StringComparison.OrdinalIgnoreCase);
        Assert.EndsWith(
            Path.Combine("payload", "payload-metadata.json"),
            options.MetadataPath,
            StringComparison.OrdinalIgnoreCase);
        Assert.EndsWith(
            Path.Combine(".openclaw-msix", "app"),
            options.InstallDirectory,
            StringComparison.OrdinalIgnoreCase);
        Assert.Empty(options.OpenClawArguments);
    }

    private static string GetArchitecture() =>
        System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture switch
        {
            System.Runtime.InteropServices.Architecture.X64 => "x64",
            System.Runtime.InteropServices.Architecture.Arm64 => "arm64",
            _ => throw new PlatformNotSupportedException()
        };
}
