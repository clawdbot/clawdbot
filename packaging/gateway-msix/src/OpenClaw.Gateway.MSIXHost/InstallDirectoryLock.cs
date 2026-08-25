using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace OpenClaw.MSIXHost;

internal static class InstallDirectoryLock
{
    private const uint HandleFlagInherit = 0x00000001;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(30);

    public static string GetPath(string installDirectory)
    {
        string? installRoot = Path.GetDirectoryName(installDirectory);
        if (string.IsNullOrWhiteSpace(installRoot))
        {
            throw new InvalidOperationException(
                "The install directory must have a parent directory.");
        }

        return Path.Combine(
            installRoot,
            $".{Path.GetFileName(installDirectory)}.install.lock");
    }

    public static async Task<FileStream> AcquireAsync(
        string installDirectory,
        CancellationToken cancellationToken)
    {
        string lockPath = GetPath(installDirectory);
        var stopwatch = Stopwatch.StartNew();
        IOException? lastException = null;
        while (stopwatch.Elapsed < Timeout)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var stream = new FileStream(
                    lockPath,
                    FileMode.OpenOrCreate,
                    FileAccess.ReadWrite,
                    FileShare.None,
                    bufferSize: 1,
                    FileOptions.None);
                try
                {
                    PreventChildProcessInheritance(stream);
                    return stream;
                }
                catch
                {
                    stream.Dispose();
                    throw;
                }
            }
            catch (IOException exception)
            {
                lastException = exception;
                await Task.Delay(250, cancellationToken);
            }
        }

        throw new TimeoutException(
            $"Timed out waiting for the installation lock: {lockPath}",
            lastException);
    }

    private static void PreventChildProcessInheritance(FileStream stream)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        if (!SetHandleInformation(
            stream.SafeFileHandle.DangerousGetHandle(),
            HandleFlagInherit,
            0))
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Unable to make the installation lock non-inheritable.");
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(
        IntPtr handle,
        uint mask,
        uint flags);
}
