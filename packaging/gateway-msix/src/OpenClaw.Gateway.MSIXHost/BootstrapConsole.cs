namespace OpenClaw.MSIXHost;

public enum BootstrapAction
{
    PrepareFast,
    PrepareFull
}

public static class BootstrapConsole
{
    public static BootstrapAction PromptForAction(
        string installDirectory,
        TextReader input,
        TextWriter output)
    {
        if (!Directory.Exists(installDirectory))
        {
            return BootstrapAction.PrepareFast;
        }

        output.WriteLine();
        output.WriteLine("OpenClaw gateway files were prepared by an earlier launch:");
        output.WriteLine($"  {installDirectory}");
        output.WriteLine();
        output.WriteLine("If OpenClaw is already configured and working, you can close");
        output.WriteLine("this window and launch it with:");
        output.WriteLine("  openclaw gateway run");

        output.WriteLine();
        output.WriteLine("[C] Continue with fast verification [recommended]");
        output.WriteLine("[R] Retry preparation with full verification and repair");

        while (true)
        {
            output.Write("Choose an option [C]: ");
            string? response = input.ReadLine();
            if (string.IsNullOrWhiteSpace(response) ||
                response.Equals("c", StringComparison.OrdinalIgnoreCase))
            {
                return BootstrapAction.PrepareFast;
            }

            if (response.Equals("r", StringComparison.OrdinalIgnoreCase))
            {
                return BootstrapAction.PrepareFull;
            }

            output.WriteLine("Enter C or R.");
        }
    }

    public static void WritePreparationSummary(
        TextWriter output,
        StagedPayload payload)
    {
        output.WriteLine();
        output.WriteLine("OpenClaw gateway files are ready.");
        output.WriteLine(
            payload.Reused
                ? "The existing prepared payload was verified and reused."
                : "The packaged payload was verified and prepared.");
        output.WriteLine($"Prepared files: {payload.DirectoryPath}");
        output.WriteLine();
        output.WriteLine("Next steps:");
        output.WriteLine("  1. Configure OpenClaw:");
        output.WriteLine(
            "     openclaw setup --classic --mode local --no-install-daemon");
        output.WriteLine("  2. Start the gateway after setup:");
        output.WriteLine("     openclaw gateway run");
        output.WriteLine();
        output.WriteLine(
            "This bootstrap launch did not start the gateway automatically.");
        output.WriteLine(
            "You can close this window after noting the commands above.");
    }

    public static void WaitForExit(TextReader input, TextWriter output)
    {
        output.WriteLine();
        output.Write("Press Enter to close this window...");
        input.ReadLine();
    }
}
