namespace OpenClaw.MSIXHost.Tests;

public sealed class HostDiagnosticLogTests : IDisposable
{
    private readonly string _testDirectory = TestDirectory.Create();

    [Fact]
    public void WritePersistsTimestampedProcessDiagnostics()
    {
        string path = Path.Combine(_testDirectory, "logs", "host.log");

        using (HostDiagnosticLog log = HostDiagnosticLog.Create(path))
        {
            log.Write("Installing payload.");
        }

        string content = File.ReadAllText(path);
        Assert.Contains($"pid={Environment.ProcessId}", content, StringComparison.Ordinal);
        Assert.Contains("Installing payload.", content, StringComparison.Ordinal);
    }

    [Fact]
    public void ConcurrentInvocationsSerializeCompleteLogRecords()
    {
        string path = Path.Combine(_testDirectory, "logs", "host.log");

        using HostDiagnosticLog first = HostDiagnosticLog.Create(path);
        using HostDiagnosticLog second = HostDiagnosticLog.Create(path);
        Parallel.Invoke(
            () =>
            {
                for (int index = 0; index < 100; index++)
                {
                    first.Write($"First invocation {index}.");
                }
            },
            () =>
            {
                for (int index = 0; index < 100; index++)
                {
                    second.Write($"Second invocation {index}.");
                }
            });

        string[] lines = File.ReadAllLines(path);
        Assert.Equal(200, lines.Length);
        Assert.All(lines, line => Assert.Contains(" invocation ", line));
    }

    public void Dispose()
    {
        Directory.Delete(_testDirectory, recursive: true);
        GC.SuppressFinalize(this);
    }
}
