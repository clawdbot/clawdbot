namespace OpenClaw.MSIXHost.Tests;

public sealed class GatewayLauncherTests : IDisposable
{
    private readonly string _payloadDirectory = TestDirectory.Create();

    public GatewayLauncherTests()
    {
        File.WriteAllText(
            Path.Combine(_payloadDirectory, "openclaw.mjs"),
            "console.log('fixture');");
    }

    [Fact]
    public void CreateStartInfoDefaultsToForegroundGateway()
    {
        var startInfo = GatewayLauncher.CreateStartInfo(
            "node",
            _payloadDirectory,
            []);

        Assert.False(startInfo.UseShellExecute);
        Assert.True(startInfo.RedirectStandardError);
        Assert.Equal(_payloadDirectory, startInfo.WorkingDirectory);
        Assert.Equal(
            "external",
            startInfo.Environment["OPENCLAW_SUPERVISOR_MODE"]);
        Assert.Equal("1", startInfo.Environment["OPENCLAW_NO_AUTO_UPDATE"]);
        Assert.Equal(
            [
                Path.Combine(_payloadDirectory, "openclaw.mjs"),
                "gateway",
                "run"
            ],
            startInfo.ArgumentList);
    }

    [Fact]
    public async Task ForwardStandardErrorSuppressesModulePreparationClixml()
    {
        const string input = """
            #< CLIXML
            <Objs><Obj S="progress"><MS><PR><AV>Preparing modules for first use.</AV></PR></MS></Obj></Objs>
            Missing config.
            """;
        var output = new StringWriter();

        await GatewayLauncher.ForwardStandardErrorAsync(
            new StringReader(input),
            output,
            CancellationToken.None);

        Assert.Equal($"Missing config.{Environment.NewLine}", output.ToString());
    }

    [Fact]
    public async Task ForwardStandardErrorPreservesOtherClixml()
    {
        const string input = """
            #< CLIXML
            <Objs><S>Actual PowerShell failure</S></Objs>
            """;
        var output = new StringWriter();

        await GatewayLauncher.ForwardStandardErrorAsync(
            new StringReader(input),
            output,
            CancellationToken.None);

        Assert.Contains("#< CLIXML", output.ToString(), StringComparison.Ordinal);
        Assert.Contains(
            "Actual PowerShell failure",
            output.ToString(),
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task ForwardStandardErrorPreservesMixedProgressAndErrorClixml()
    {
        const string input = """
            #< CLIXML
            <Objs><Obj S="progress"><S>Preparing modules for first use.</S></Obj><Obj S="error"><S>Gateway failure</S></Obj></Objs>
            """;
        var output = new StringWriter();

        await GatewayLauncher.ForwardStandardErrorAsync(
            new StringReader(input),
            output,
            CancellationToken.None);

        Assert.Contains(
            "Preparing modules for first use.",
            output.ToString(),
            StringComparison.Ordinal);
        Assert.Contains("Gateway failure", output.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void CreateStartInfoPreservesExplicitArguments()
    {
        string[] arguments = ["status", "--json", "value with spaces"];

        var startInfo = GatewayLauncher.CreateStartInfo(
            "node",
            _payloadDirectory,
            arguments);

        Assert.False(startInfo.RedirectStandardError);
        Assert.Equal(
            "external",
            startInfo.Environment["OPENCLAW_SUPERVISOR_MODE"]);
        Assert.Equal("1", startInfo.Environment["OPENCLAW_NO_AUTO_UPDATE"]);
        Assert.Equal(
            [Path.Combine(_payloadDirectory, "openclaw.mjs"), .. arguments],
            startInfo.ArgumentList);
    }

    [Theory]
    [InlineData("update", "--yes")]
    [InlineData("--update")]
    [InlineData("gateway", "call", "update.run")]
    [InlineData("gateway", "install")]
    [InlineData("setup", "--install-daemon")]
    [InlineData("onboard", "--mode", "local")]
    public void CreateStartInfoForwardsCommandsWithoutInterpretation(
        params string[] arguments)
    {
        var startInfo = GatewayLauncher.CreateStartInfo(
            "node",
            _payloadDirectory,
            arguments);

        Assert.Equal(
            [Path.Combine(_payloadDirectory, "openclaw.mjs"), .. arguments],
            startInfo.ArgumentList);
    }

    public void Dispose()
    {
        Directory.Delete(_payloadDirectory, recursive: true);
        GC.SuppressFinalize(this);
    }
}
