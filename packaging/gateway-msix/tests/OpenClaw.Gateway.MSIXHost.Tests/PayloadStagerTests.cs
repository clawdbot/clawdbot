using System.Formats.Tar;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenClaw.MSIXHost.Tests;

public sealed class PayloadStagerTests : IDisposable
{
    private readonly string _testDirectory = TestDirectory.Create();

    [Fact]
    public async Task StageAsyncExtractsAndReusesVerifiedPayload()
    {
        var messages = new List<string>();
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("console.log('fixture');")
            },
            new PaxTarEntry(TarEntryType.RegularFile, "dist/app.js")
            {
                DataStream = TextStream("export const value = 1;")
            }
        ]);
        var stager = new PayloadStager(
            Path.Combine(_testDirectory, "app"),
            messages.Add);

        StagedPayload first = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);
        StagedPayload second = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);

        Assert.Equal(first.DirectoryPath, second.DirectoryPath);
        Assert.Equal(first.PayloadSha256, second.PayloadSha256);
        Assert.False(first.Reused);
        Assert.True(second.Reused);
        Assert.True(File.Exists(Path.Combine(first.DirectoryPath, "openclaw.mjs")));
        Assert.True(File.Exists(Path.Combine(first.DirectoryPath, "dist", "app.js")));
        Assert.Contains(
            messages,
            message => message.Contains(
                "skipping full per-file verification",
                StringComparison.Ordinal));
        Assert.Equal(
            2,
            messages.Count(message =>
                string.Equals(
                    message,
                    "Released the installation lock.",
                    StringComparison.Ordinal)));
    }

    [Fact]
    public async Task StageAsyncReleasesInstallLockBeforeReturningPayload()
    {
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("console.log('fixture');")
            }
        ]);
        string installDirectory = Path.Combine(_testDirectory, "app");
        var stager = new PayloadStager(installDirectory);

        await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);

        using FileStream acquiredAfterStaging = new(
            Path.Combine(_testDirectory, ".app.install.lock"),
            FileMode.OpenOrCreate,
            FileAccess.ReadWrite,
            FileShare.None);
        Assert.True(acquiredAfterStaging.CanWrite);
    }

    [Fact]
    public async Task StageAsyncMigratesExistingInventoryWhenMarkerIsMissing()
    {
        var messages = new List<string>();
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("console.log('fixture');")
            }
        ]);
        var stager = new PayloadStager(
            Path.Combine(_testDirectory, "app"),
            messages.Add);
        StagedPayload staged = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);
        File.Delete(Path.Combine(
            staged.DirectoryPath,
            ".payload-verified-sha256"));
        messages.Clear();

        StagedPayload verified = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);

        Assert.Equal(staged.DirectoryPath, verified.DirectoryPath);
        Assert.Equal(staged.PayloadSha256, verified.PayloadSha256);
        Assert.True(verified.Reused);
        Assert.Contains(
            "Migrated the existing payload inventory to the fast verification marker.",
            messages);
        Assert.True(File.Exists(Path.Combine(
            staged.DirectoryPath,
            ".payload-verified-sha256")));
    }

    [Fact]
    public async Task StageAsyncRepairsNullInventoryHashWithoutMarker()
    {
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("original")
            }
        ]);
        var stager = new PayloadStager(Path.Combine(_testDirectory, "app"));
        StagedPayload staged = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);
        File.Delete(Path.Combine(
            staged.DirectoryPath,
            ".payload-verified-sha256"));
        await File.WriteAllTextAsync(
            Path.Combine(staged.DirectoryPath, ".payload-inventory.json"),
            """{"PayloadSha256":null,"Files":[]}""",
            CancellationToken.None);

        StagedPayload repaired = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);

        Assert.Equal(staged, repaired);
        Assert.Equal(
            "original",
            await File.ReadAllTextAsync(
                Path.Combine(repaired.DirectoryPath, "openclaw.mjs"),
                CancellationToken.None));
    }

    [Fact]
    public async Task StageAsyncExtractsAndReusesZeroLengthFile()
    {
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("console.log('fixture');")
            },
            new PaxTarEntry(TarEntryType.RegularFile, "patches/.gitkeep")
        ]);
        var stager = new PayloadStager(Path.Combine(_testDirectory, "app"));

        StagedPayload first = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);
        StagedPayload second = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);

        string emptyFile = Path.Combine(first.DirectoryPath, "patches", ".gitkeep");
        Assert.Equal(first.DirectoryPath, second.DirectoryPath);
        Assert.Equal(first.PayloadSha256, second.PayloadSha256);
        Assert.False(first.Reused);
        Assert.True(second.Reused);
        Assert.True(File.Exists(emptyFile));
        Assert.Equal(0, new FileInfo(emptyFile).Length);
    }

    [Fact]
    public async Task StageAsyncReplacesPayloadAtTheSameInstallPath()
    {
        PackageFixture firstFixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("first")
            },
            new PaxTarEntry(TarEntryType.RegularFile, "old-only.js")
            {
                DataStream = TextStream("old")
            }
        ]);
        PackageFixture secondFixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("second")
            }
        ]);
        string installDirectory = Path.Combine(_testDirectory, "app");
        var stager = new PayloadStager(installDirectory);

        StagedPayload first = await stager.StageAsync(
            firstFixture.ArchivePath,
            firstFixture.MetadataPath,
            CancellationToken.None);
        StagedPayload second = await stager.StageAsync(
            secondFixture.ArchivePath,
            secondFixture.MetadataPath,
            CancellationToken.None);

        Assert.Equal(installDirectory, first.DirectoryPath);
        Assert.Equal(installDirectory, second.DirectoryPath);
        Assert.NotEqual(first.PayloadSha256, second.PayloadSha256);
        Assert.Equal(
            "second",
            await File.ReadAllTextAsync(
                Path.Combine(installDirectory, "openclaw.mjs"),
                CancellationToken.None));
        Assert.False(File.Exists(Path.Combine(installDirectory, "old-only.js")));
        Assert.Equal(
            [installDirectory],
            Directory.GetDirectories(_testDirectory));
    }

    [Fact]
    public async Task StageAsyncRecoversInterruptedDirectoryPromotion()
    {
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("original")
            }
        ]);
        string installDirectory = Path.Combine(_testDirectory, "app");
        string backupDirectory = Path.Combine(_testDirectory, ".app.previous");
        string stagingDirectory = Path.Combine(_testDirectory, ".app.staging");
        var stager = new PayloadStager(installDirectory);
        StagedPayload staged = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);
        Directory.Move(installDirectory, backupDirectory);
        Directory.CreateDirectory(stagingDirectory);
        await File.WriteAllTextAsync(
            Path.Combine(stagingDirectory, "partial.txt"),
            "partial",
            CancellationToken.None);

        StagedPayload recovered = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);

        Assert.Equal(staged.DirectoryPath, recovered.DirectoryPath);
        Assert.Equal(staged.PayloadSha256, recovered.PayloadSha256);
        Assert.True(recovered.Reused);
        Assert.True(File.Exists(Path.Combine(installDirectory, "openclaw.mjs")));
        Assert.False(Directory.Exists(backupDirectory));
        Assert.False(Directory.Exists(stagingDirectory));
    }

    [Fact]
    public async Task StageAsyncWaitsForConcurrentInstallOperation()
    {
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("original")
            }
        ]);
        string installDirectory = Path.Combine(_testDirectory, "app");
        string lockPath = Path.Combine(_testDirectory, ".app.install.lock");
        var stager = new PayloadStager(installDirectory);
        StagedPayload initial = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);

        Task<StagedPayload> waitingStage;
        using (var heldLock = new FileStream(
            lockPath,
            FileMode.OpenOrCreate,
            FileAccess.ReadWrite,
            FileShare.None))
        {
            waitingStage = stager.StageAsync(
                fixture.ArchivePath,
                fixture.MetadataPath,
                CancellationToken.None);
            await Task.Delay(200, CancellationToken.None);
            Assert.False(waitingStage.IsCompleted);
        }

        StagedPayload completed = await waitingStage;
        Assert.Equal(initial.DirectoryPath, completed.DirectoryPath);
        Assert.Equal(initial.PayloadSha256, completed.PayloadSha256);
        Assert.True(completed.Reused);
    }

    [Fact]
    public async Task StageAsyncRejectsHashMismatch()
    {
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("fixture")
            }
        ]);
        await File.AppendAllTextAsync(
            fixture.ArchivePath,
            "tampered",
            CancellationToken.None);
        var stager = new PayloadStager(Path.Combine(_testDirectory, "app"));

        InvalidDataException exception = await Assert.ThrowsAsync<InvalidDataException>(
            () => stager.StageAsync(
                fixture.ArchivePath,
                fixture.MetadataPath,
                CancellationToken.None));

        Assert.Contains("SHA-256", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task StageAsyncRejectsArchitectureMismatch()
    {
        string mismatchedArchitecture = RuntimeInformation.ProcessArchitecture ==
            Architecture.X64 ? "arm64" : "x64";
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("fixture")
            }
        ],
        mismatchedArchitecture);
        var stager = new PayloadStager(Path.Combine(_testDirectory, "app"));

        InvalidDataException exception = await Assert.ThrowsAsync<InvalidDataException>(
            () => stager.StageAsync(
                fixture.ArchivePath,
                fixture.MetadataPath,
                CancellationToken.None));

        Assert.Contains("architecture", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task StageAsyncRejectsTraversal()
    {
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "../outside.txt")
            {
                DataStream = TextStream("unsafe")
            }
        ]);
        var stager = new PayloadStager(Path.Combine(_testDirectory, "app"));

        await Assert.ThrowsAsync<InvalidDataException>(
            () => stager.StageAsync(
                fixture.ArchivePath,
                fixture.MetadataPath,
                CancellationToken.None));

        Assert.False(File.Exists(Path.Combine(_testDirectory, "outside.txt")));
    }

    [Fact]
    public async Task StageAsyncRejectsLinks()
    {
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.SymbolicLink, "openclaw.mjs")
            {
                LinkName = "outside.txt"
            }
        ]);
        var stager = new PayloadStager(Path.Combine(_testDirectory, "app"));

        await Assert.ThrowsAsync<InvalidDataException>(
            () => stager.StageAsync(
                fixture.ArchivePath,
                fixture.MetadataPath,
                CancellationToken.None));
    }

    [Fact]
    public async Task StageAsyncRejectsWindowsDeviceNames()
    {
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "dist/CON.txt")
            {
                DataStream = TextStream("unsafe")
            }
        ]);
        var stager = new PayloadStager(Path.Combine(_testDirectory, "app"));

        await Assert.ThrowsAsync<InvalidDataException>(
            () => stager.StageAsync(
                fixture.ArchivePath,
                fixture.MetadataPath,
                CancellationToken.None));
    }

    [Fact]
    public async Task StageAsyncRejectsCaseInsensitiveDuplicateFiles()
    {
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("first")
            },
            new PaxTarEntry(TarEntryType.RegularFile, "OPENCLAW.MJS")
            {
                DataStream = TextStream("second")
            }
        ]);
        var stager = new PayloadStager(Path.Combine(_testDirectory, "app"));

        await Assert.ThrowsAsync<InvalidDataException>(
            () => stager.StageAsync(
                fixture.ArchivePath,
                fixture.MetadataPath,
                CancellationToken.None));
    }

    [Fact]
    public async Task StageAsyncRepairsModifiedInstalledFile()
    {
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("original")
            }
        ]);
        var stager = new PayloadStager(
            Path.Combine(_testDirectory, "app"),
            verifyInstalledPayload: true);
        StagedPayload staged = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);
        await File.WriteAllTextAsync(
            Path.Combine(staged.DirectoryPath, "openclaw.mjs"),
            "modified",
            CancellationToken.None);

        StagedPayload repaired = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);

        Assert.Equal(staged.DirectoryPath, repaired.DirectoryPath);
        Assert.Equal(
            "original",
            await File.ReadAllTextAsync(
                Path.Combine(repaired.DirectoryPath, "openclaw.mjs"),
                CancellationToken.None));
    }

    [Fact]
    public async Task StageAsyncDoesNotTrustModifiedInstalledInventory()
    {
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("original")
            }
        ]);
        var stager = new PayloadStager(
            Path.Combine(_testDirectory, "app"),
            verifyInstalledPayload: true);
        StagedPayload staged = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);
        string entryPoint = Path.Combine(staged.DirectoryPath, "openclaw.mjs");
        await File.WriteAllTextAsync(entryPoint, "modified", CancellationToken.None);

        string inventoryPath = Path.Combine(
            staged.DirectoryPath,
            ".payload-inventory.json");
        JsonNode inventory = JsonNode.Parse(
            await File.ReadAllTextAsync(inventoryPath, CancellationToken.None))!;
        JsonObject entry = inventory["Files"]!.AsArray()[0]!.AsObject();
        entry["Length"] = new FileInfo(entryPoint).Length;
        await using (FileStream modifiedStream = File.OpenRead(entryPoint))
        {
            entry["Sha256"] = Convert.ToHexString(
                await SHA256.HashDataAsync(
                    modifiedStream,
                    CancellationToken.None)).ToLowerInvariant();
        }
        await File.WriteAllTextAsync(
            inventoryPath,
            inventory.ToJsonString(),
            CancellationToken.None);

        await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);

        Assert.Equal(
            "original",
            await File.ReadAllTextAsync(entryPoint, CancellationToken.None));
    }

    [Fact]
    public async Task StageAsyncRepairsIncompleteInstalledInventory()
    {
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("original")
            }
        ]);
        var stager = new PayloadStager(
            Path.Combine(_testDirectory, "app"),
            verifyInstalledPayload: true);
        StagedPayload staged = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);
        string inventoryPath = Path.Combine(
            staged.DirectoryPath,
            ".payload-inventory.json");
        await File.WriteAllTextAsync(
            inventoryPath,
            JsonSerializer.Serialize(new
            {
                staged.PayloadSha256,
                Files = (object?)null
            }),
            CancellationToken.None);

        StagedPayload repaired = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);

        Assert.Equal(staged, repaired);
        Assert.True(File.Exists(Path.Combine(repaired.DirectoryPath, "openclaw.mjs")));
    }

    [Fact]
    public async Task StageAsyncRemovesUnexpectedInstalledFile()
    {
        PackageFixture fixture = await CreatePackageAsync(
        [
            new PaxTarEntry(TarEntryType.RegularFile, "openclaw.mjs")
            {
                DataStream = TextStream("original")
            }
        ]);
        var stager = new PayloadStager(
            Path.Combine(_testDirectory, "app"),
            verifyInstalledPayload: true);
        StagedPayload staged = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);
        await File.WriteAllTextAsync(
            Path.Combine(staged.DirectoryPath, "unexpected.txt"),
            "unexpected",
            CancellationToken.None);

        StagedPayload repaired = await stager.StageAsync(
            fixture.ArchivePath,
            fixture.MetadataPath,
            CancellationToken.None);

        Assert.Equal(staged.DirectoryPath, repaired.DirectoryPath);
        Assert.False(File.Exists(Path.Combine(repaired.DirectoryPath, "unexpected.txt")));
    }

    private async Task<PackageFixture> CreatePackageAsync(
        IReadOnlyList<TarEntry> entries,
        string? architecture = null)
    {
        string archivePath = Path.Combine(_testDirectory, $"payload-{Guid.NewGuid():N}.tar.gz");
        await using (FileStream archiveStream = File.Create(archivePath))
        await using (var gzipStream = new GZipStream(
            archiveStream,
            CompressionLevel.SmallestSize))
        using (var writer = new TarWriter(gzipStream, leaveOpen: false))
        {
            foreach (TarEntry entry in entries)
            {
                writer.WriteEntry(entry);
                entry.DataStream?.Dispose();
            }
        }

        string hash;
        await using (FileStream archiveStream = File.OpenRead(archivePath))
        {
            hash = Convert.ToHexString(
                await SHA256.HashDataAsync(
                    archiveStream,
                    CancellationToken.None)).ToLowerInvariant();
        }

        string metadataPath = Path.Combine(
            _testDirectory,
            $"metadata-{Guid.NewGuid():N}.json");
        var metadata = new
        {
            repository = "https://github.com/openclaw/openclaw",
            resolvedCommit = new string('a', 40),
            architecture = architecture ??
                (RuntimeInformation.ProcessArchitecture == Architecture.Arm64
                    ? "arm64"
                    : "x64"),
            archive = Path.GetFileName(archivePath),
            sha256 = hash
        };
        await File.WriteAllTextAsync(
            metadataPath,
            JsonSerializer.Serialize(metadata),
            CancellationToken.None);

        return new PackageFixture(archivePath, metadataPath);
    }

    private static MemoryStream TextStream(string value) =>
        new(System.Text.Encoding.UTF8.GetBytes(value));

    public void Dispose()
    {
        Directory.Delete(_testDirectory, recursive: true);
        GC.SuppressFinalize(this);
    }

    private sealed record PackageFixture(string ArchivePath, string MetadataPath);
}
