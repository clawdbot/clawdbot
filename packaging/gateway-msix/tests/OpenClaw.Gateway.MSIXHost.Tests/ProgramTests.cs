namespace OpenClaw.MSIXHost.Tests;

public sealed class ProgramTests
{
    [Fact]
    public void BootstrapLaunchWaitsForExit()
    {
        Assert.True(Program.ShouldWaitForBootstrapExit([]));
    }

    [Fact]
    public void ForwardedCommandReturnsWithoutExitPrompt()
    {
        Assert.False(Program.ShouldWaitForBootstrapExit(["--version"]));
    }
}
