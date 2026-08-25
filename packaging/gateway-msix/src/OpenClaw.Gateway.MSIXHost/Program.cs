namespace OpenClaw.MSIXHost;

internal static class Program
{
    internal static bool ShouldWaitForBootstrapExit(
        IReadOnlyList<string> arguments) =>
        arguments.Count == 0;

    public static async Task<int> Main(string[] args)
    {
        HostDiagnosticLog? diagnostics = null;
        bool diagnosticWarningWritten = false;
        bool consoleWarningWritten = false;
        bool waitForBootstrapExit = ShouldWaitForBootstrapExit(args);

        void WriteConsoleError(string message)
        {
            try
            {
                Console.Error.WriteLine(message);
            }
            catch (Exception exception) when (
                exception is IOException or ObjectDisposedException)
            {
                if (!consoleWarningWritten)
                {
                    consoleWarningWritten = true;
                    WriteDiagnostic(
                        $"Console error output failed: {exception.GetType().Name}.");
                }
            }
        }

        try
        {
            diagnostics = HostDiagnosticLog.Create();
        }
        catch (Exception exception) when (
            exception is IOException or
            UnauthorizedAccessException or
            InvalidOperationException)
        {
            diagnosticWarningWritten = true;
            WriteConsoleError(
                $"openclaw: Unable to create diagnostics: {exception.Message}");
        }

        void WriteDiagnostic(string message)
        {
            if (diagnostics is null)
            {
                return;
            }

            try
            {
                diagnostics.Write(message);
            }
            catch (Exception exception) when (
                exception is IOException or
                UnauthorizedAccessException or
                ObjectDisposedException)
            {
                if (!diagnosticWarningWritten)
                {
                    diagnosticWarningWritten = true;
                    WriteConsoleError(
                        $"openclaw: Unable to write diagnostics: {exception.Message}");
                }
            }
        }

        static string GetDiagnosticFailure(Exception exception) =>
            exception switch
            {
                InvalidDataException or
                TimeoutException or
                PlatformNotSupportedException or
                FileNotFoundException =>
                    $"{exception.GetType().Name}: {exception.Message}",
                _ => exception.GetType().Name
            };

        void ReportProgress(string message)
        {
            WriteDiagnostic(message);
            WriteConsoleError($"openclaw: {message}");
        }

        try
        {
            WriteDiagnostic("Host started.");
            if (diagnostics is not null)
            {
                WriteConsoleError(
                    $"openclaw: Diagnostics: {diagnostics.Path}");
            }

            HostOptions options = HostOptions.Parse(args);
            bool isBootstrapLaunch = options.OpenClawArguments.Count == 0;
            bool verifyInstalledPayload = false;
            if (isBootstrapLaunch)
            {
                BootstrapAction action = BootstrapConsole.PromptForAction(
                    options.InstallDirectory,
                    Console.In,
                    Console.Out);
                verifyInstalledPayload = action == BootstrapAction.PrepareFull;
            }

            var stager = new PayloadStager(
                options.InstallDirectory,
                ReportProgress,
                verifyInstalledPayload);
            StagedPayload payload = await stager.StageAsync(
                options.PayloadPath,
                options.MetadataPath,
                CancellationToken.None);

            if (isBootstrapLaunch)
            {
                BootstrapConsole.WritePreparationSummary(Console.Out, payload);
                return 0;
            }

            int exitCode = await GatewayLauncher.RunAsync(
                options.NodePath,
                payload.DirectoryPath,
                options.OpenClawArguments,
                CancellationToken.None,
                ReportProgress);
            if (exitCode == 78)
            {
                ReportProgress(
                    "OpenClaw reported a configuration error (exit code 78). " +
                    "For first-run setup, run " +
                    "`openclaw setup --classic --mode local --no-install-daemon`, " +
                    "then retry.");
            }

            return exitCode;
        }
        catch (Exception exception)
        {
            WriteDiagnostic($"Unhandled failure: {GetDiagnosticFailure(exception)}");
            WriteConsoleError($"openclaw: {exception.Message}");
            if (diagnostics is not null)
            {
                WriteConsoleError(
                    $"openclaw: See diagnostics: {diagnostics.Path}");
            }
            return 1;
        }
        finally
        {
            if (waitForBootstrapExit && !Console.IsInputRedirected)
            {
                try
                {
                    BootstrapConsole.WaitForExit(Console.In, Console.Out);
                }
                catch (Exception exception) when (
                    exception is IOException or ObjectDisposedException)
                {
                    WriteDiagnostic(
                        $"Unable to wait for console input: {exception.GetType().Name}.");
                }
            }

            WriteDiagnostic("Host exiting.");
            diagnostics?.Dispose();
        }
    }
}
