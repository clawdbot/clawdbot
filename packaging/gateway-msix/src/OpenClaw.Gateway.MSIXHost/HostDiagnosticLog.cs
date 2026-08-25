using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace OpenClaw.MSIXHost;

public sealed class HostDiagnosticLog : IDisposable
{
    private const int ErrorInsufficientBuffer = 122;
    private const int AppModelErrorNoPackage = 15700;
    private readonly object _sync = new();
    private readonly Mutex _writeMutex;
    private bool _disposed;

    private HostDiagnosticLog(string path)
    {
        Path = path;
        string? directory = System.IO.Path.GetDirectoryName(path);
        if (string.IsNullOrWhiteSpace(directory))
        {
            throw new InvalidOperationException("The diagnostic log path has no directory.");
        }

        Directory.CreateDirectory(directory);
        string mutexSuffix = Convert.ToHexString(SHA256.HashData(
            Encoding.UTF8.GetBytes(path.ToUpperInvariant())));
        _writeMutex = new Mutex(
            initiallyOwned: false,
            $"Local\\OpenClawGatewayMSIX.Log.{mutexSuffix}");
    }

    public string Path { get; }

    public static HostDiagnosticLog Create()
    {
        string localAppData = Environment.GetFolderPath(
            Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData))
        {
            throw new InvalidOperationException(
                "The local application data directory is unavailable.");
        }

        string? packageFamilyName = GetPackageFamilyName();
        string logRoot = packageFamilyName is null
            ? System.IO.Path.Combine(localAppData, "OpenClawGatewayMSIX")
            : System.IO.Path.Combine(
                localAppData,
                "Packages",
                packageFamilyName,
                "LocalState",
                "OpenClawGatewayMSIX");
        return Create(System.IO.Path.Combine(logRoot, "Logs", "openclaw.log"));
    }

    public static HostDiagnosticLog Create(string path) =>
        new(System.IO.Path.GetFullPath(path));

    public void Write(string message)
    {
        string line = string.Create(
            CultureInfo.InvariantCulture,
            $"{DateTimeOffset.Now:O} pid={Environment.ProcessId} {message}");
        lock (_sync)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            bool ownsMutex = false;
            try
            {
                try
                {
                    ownsMutex = _writeMutex.WaitOne(TimeSpan.FromSeconds(5));
                }
                catch (AbandonedMutexException)
                {
                    ownsMutex = true;
                }

                if (!ownsMutex)
                {
                    throw new IOException(
                        "Timed out waiting to append to the diagnostic log.");
                }

                using var stream = new FileStream(
                    Path,
                    FileMode.Append,
                    FileAccess.Write,
                    FileShare.ReadWrite,
                    bufferSize: 4096,
                    FileOptions.WriteThrough);
                using var writer = new StreamWriter(stream);
                writer.WriteLine(line);
            }
            finally
            {
                if (ownsMutex)
                {
                    _writeMutex.ReleaseMutex();
                }
            }
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        lock (_sync)
        {
            _writeMutex.Dispose();
            _disposed = true;
        }

        GC.SuppressFinalize(this);
    }

    private static string? GetPackageFamilyName()
    {
        if (!OperatingSystem.IsWindows())
        {
            return null;
        }

        uint length = 0;
        int result = GetCurrentPackageFamilyName(ref length, null);
        if (result == AppModelErrorNoPackage)
        {
            return null;
        }

        if (result != ErrorInsufficientBuffer || length == 0)
        {
            throw new InvalidOperationException(
                $"Unable to determine package identity (error {result}).");
        }

        var value = new char[length];
        result = GetCurrentPackageFamilyName(ref length, value);
        if (result != 0)
        {
            throw new InvalidOperationException(
                $"Unable to determine package identity (error {result}).");
        }

        return new string(value, 0, checked((int)length - 1));
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetCurrentPackageFamilyName(
        ref uint packageFamilyNameLength,
        [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)]
        char[]? packageFamilyName);
}
