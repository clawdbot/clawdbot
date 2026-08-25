namespace OpenClaw.MSIXHost.Tests;

public sealed class BootstrapConsoleTests : IDisposable
{
    private readonly string _testDirectory = TestDirectory.Create();

    [Fact]
    public void PromptForActionSkipsPromptForFirstLaunch()
    {
        var output = new StringWriter();

        BootstrapAction action = BootstrapConsole.PromptForAction(
            Path.Combine(_testDirectory, "missing"),
            new StringReader("r"),
            output);

        Assert.Equal(BootstrapAction.PrepareFast, action);
        Assert.Empty(output.ToString());
    }

    [Theory]
    [InlineData("")]
    [InlineData("c")]
    [InlineData("C")]
    public void PromptForActionDefaultsToFastVerification(string response)
    {
        Directory.CreateDirectory(Path.Combine(_testDirectory, "app"));

        BootstrapAction action = BootstrapConsole.PromptForAction(
            Path.Combine(_testDirectory, "app"),
            new StringReader(response),
            new StringWriter());

        Assert.Equal(BootstrapAction.PrepareFast, action);
    }

    [Fact]
    public void PromptForActionAllowsFullVerification()
    {
        string installDirectory = Path.Combine(_testDirectory, "app");
        Directory.CreateDirectory(installDirectory);
        var output = new StringWriter();

        BootstrapAction action = BootstrapConsole.PromptForAction(
            installDirectory,
            new StringReader($"invalid{Environment.NewLine}r"),
            output);

        Assert.Equal(BootstrapAction.PrepareFull, action);
        Assert.Contains(
            "Enter C or R",
            output.ToString(),
            StringComparison.Ordinal);
    }

    [Fact]
    public void PromptForActionMarksFastVerificationRecommended()
    {
        string installDirectory = Path.Combine(_testDirectory, "app");
        Directory.CreateDirectory(installDirectory);
        var output = new StringWriter();

        BootstrapConsole.PromptForAction(
            installDirectory,
            new StringReader("c"),
            output);

        Assert.Contains(
            "[C] Continue with fast verification [recommended]",
            output.ToString(),
            StringComparison.Ordinal);
        Assert.Contains(
            "openclaw gateway run",
            output.ToString(),
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(true, "existing prepared payload was verified and reused")]
    [InlineData(false, "packaged payload was verified and prepared")]
    public void WritePreparationSummaryUsesPackagedAlias(
        bool reused,
        string expectedStatus)
    {
        var output = new StringWriter();

        BootstrapConsole.WritePreparationSummary(
            output,
            new StagedPayload(
                Path.Combine(_testDirectory, "app"),
                new string('a', 64),
                reused));

        string summary = output.ToString();
        Assert.Contains(expectedStatus, summary, StringComparison.Ordinal);
        Assert.Contains(
            "openclaw setup --classic --mode local --no-install-daemon",
            summary,
            StringComparison.Ordinal);
        Assert.Contains(
            "openclaw gateway run",
            summary,
            StringComparison.Ordinal);
        Assert.Contains(
            "did not start the gateway automatically",
            summary,
            StringComparison.Ordinal);
        Assert.Contains(
            "close this window",
            summary,
            StringComparison.Ordinal);
    }

    [Fact]
    public void WaitForExitPrintsPersistentConsoleInstruction()
    {
        var output = new StringWriter();

        BootstrapConsole.WaitForExit(
            new StringReader(Environment.NewLine),
            output);

        Assert.Contains(
            "Press Enter to close this window",
            output.ToString(),
            StringComparison.Ordinal);
    }

    public void Dispose()
    {
        Directory.Delete(_testDirectory, recursive: true);
        GC.SuppressFinalize(this);
    }
}
