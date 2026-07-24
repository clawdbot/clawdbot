// Creates compact SQLite snapshots only after verifying both source and output.
import { createHash, randomUUID } from "node:crypto";
import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/engine-storage.js";
import { runExec } from "../process/exec.js";
import { formatErrorMessage } from "./errors.js";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { resolveSystemBin } from "./resolve-system-bin.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";

const SQLITE_DIRECTORY_MODE = 0o700;
const WINDOWS_DIRECTORY_EXISTS_MARKER = "OPENCLAW_SQLITE_DIRECTORY_EXISTS";

function resolveSqliteFilesystemPath(pathname: string): string {
  if (process.platform !== "win32") {
    return pathname;
  }
  // Node normalizes long paths for fs, but DatabaseSync and VACUUM INTO pass
  // filesystem names directly to SQLite's Windows VFS.
  return path.toNamespacedPath(path.resolve(pathname));
}

// Managed directory creation accepts existing paths. CreateDirectoryW applies the
// protected DACL atomically while preserving fail-if-exists semantics.
const WINDOWS_PRIVATE_DIRECTORY_NATIVE_SOURCE = `
using System;
using System.Runtime.InteropServices;

public static class OpenClawPrivateDirectory
{
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        public int InheritHandle;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string securityDescriptor,
        uint revision,
        out IntPtr convertedSecurityDescriptor,
        out uint convertedSecurityDescriptorSize);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateDirectoryW(
        string path,
        ref SecurityAttributes securityAttributes);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static int Create(string path, string securityDescriptor)
    {
        IntPtr descriptor;
        uint descriptorSize;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                securityDescriptor,
                1,
                out descriptor,
                out descriptorSize))
        {
            return Marshal.GetLastWin32Error();
        }

        try
        {
            var attributes = new SecurityAttributes
            {
                Length = Marshal.SizeOf(typeof(SecurityAttributes)),
                SecurityDescriptor = descriptor,
                InheritHandle = 0,
            };
            return CreateDirectoryW(path, ref attributes) ? 0 : Marshal.GetLastWin32Error();
        }
        finally
        {
            LocalFree(descriptor);
        }
    }
}
`;

export type SqliteSnapshotValidator = (database: DatabaseSync, databaseLabel: string) => void;

type CreateVerifiedSqliteSnapshotOptions = {
  sourcePath: string;
  targetPath: string;
  /** Final caller checks around publication; failures remove only this helper's target. */
  afterPublish?: (guard: PublishedSqliteFileGuard) => void;
  beforePublish?: () => void | Promise<void>;
  requireNonEmptySource?: boolean;
  transform?: (database: DatabaseSync) => void | Promise<void>;
  validate?: SqliteSnapshotValidator;
};

type SqliteFileContent = {
  sha256: string;
  sizeBytes: number;
};

type PublishedSqliteFileGuard = {
  assertTargetMatchesExpectedContent: (finalCheck?: () => void) => void;
  assertTargetUnchanged: (finalCheck?: () => void) => void;
};

type PublishVerifiedSqliteFileOptions = {
  sourceIdentity: Stats;
  sourcePath: string;
  targetPath: string;
  expectedContent: SqliteFileContent;
  requireAtomicPublication?: boolean;
  beforePublish?: () => void | Promise<void>;
  validatePublished?: (publishedPath: string) => void | Promise<void>;
  /** Runs last. Call the supplied guard after any caller-specific checks. */
  afterPublish?: (guard: PublishedSqliteFileGuard) => void;
};

type VerifiedSqliteSnapshot = {
  path: string;
  userVersion: number;
};

export async function createPrivateSqliteDirectory(directoryPath: string): Promise<void> {
  if (process.platform !== "win32") {
    await fs.mkdir(directoryPath, { mode: SQLITE_DIRECTORY_MODE });
    return;
  }
  // This raw Win32 call bypasses Node's automatic long-path normalization.
  const nativeDirectoryPath = path.toNamespacedPath(path.resolve(directoryPath));
  const encodedPath = Buffer.from(nativeDirectoryPath, "utf8").toString("base64");
  const encodedNativeSource = Buffer.from(WINDOWS_PRIVATE_DIRECTORY_NATIVE_SOURCE, "utf8").toString(
    "base64",
  );
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    `$nativeSource = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedNativeSource}'))`,
    "Add-Type -TypeDefinition $nativeSource -Language CSharp",
    "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$security = New-Object System.Security.AccessControl.DirectorySecurity",
    "$security.SetAccessRuleProtection($true, $false)",
    "$security.SetOwner($current)",
    "$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit",
    "$propagation = [System.Security.AccessControl.PropagationFlags]::None",
    "foreach ($sidValue in @($current.Value, 'S-1-5-18', 'S-1-5-32-544')) { $sid = New-Object System.Security.Principal.SecurityIdentifier($sidValue); $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, [System.Security.AccessControl.AccessControlType]::Allow); [void]$security.AddAccessRule($rule) }",
    "$sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access",
    "$sddl = $security.GetSecurityDescriptorSddlForm($sections)",
    "$errorCode = [OpenClawPrivateDirectory]::Create($path, $sddl)",
    `if ($errorCode -eq 80 -or $errorCode -eq 183) { throw '${WINDOWS_DIRECTORY_EXISTS_MARKER}' }`,
    "if ($errorCode -ne 0) { $exception = New-Object System.ComponentModel.Win32Exception($errorCode); throw $exception }",
  ].join("; ");
  const powershell = resolveSystemBin("powershell");
  if (!powershell) {
    throw new Error("Unable to resolve PowerShell for private Windows SQLite staging.");
  }
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
  try {
    await runExec(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
      {
        timeoutMs: 10_000,
        maxBuffer: 64 * 1024,
      },
    );
  } catch (error) {
    if (String(error).includes(WINDOWS_DIRECTORY_EXISTS_MARKER)) {
      const existsError = new Error(`Private SQLite directory already exists: ${directoryPath}`);
      (existsError as NodeJS.ErrnoException).code = "EEXIST";
      throw existsError;
    }
    throw new Error(`Unable to create private Windows SQLite directory: ${directoryPath}`, {
      cause: error,
    });
  }
}

export async function createPrivateSqliteTempDirectory(
  rootPath: string,
  prefix: string,
): Promise<string> {
  if (process.platform !== "win32") {
    return await fs.mkdtemp(path.join(rootPath, prefix));
  }
  const directoryPath = path.join(rootPath, `${prefix}${randomUUID()}`);
  await createPrivateSqliteDirectory(directoryPath);
  return directoryPath;
}

async function assertRegularSourceFile(
  sourcePath: string,
  requireNonEmptySource: boolean,
): Promise<void> {
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile()) {
    throw new Error(`SQLite snapshot source must be a regular file: ${sourcePath}`);
  }
  if (requireNonEmptySource && stat.size === 0) {
    throw new Error(`SQLite snapshot source must not be empty: ${sourcePath}`);
  }
}

async function assertTargetAbsent(targetPath: string): Promise<void> {
  try {
    await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`SQLite snapshot target already exists: ${targetPath}`);
}

async function copyFileExclusive(
  source: FileHandle,
  targetPath: string,
): Promise<{ content: SqliteFileContent; identity: Stats }> {
  const sourceFingerprint = await readMutationFingerprint(source);
  let target: Awaited<ReturnType<typeof fs.open>> | undefined;
  let targetIdentity: Stats | undefined;
  try {
    target = await fs.open(targetPath, "wx+", 0o600);
    targetIdentity = await target.stat();
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const hash = createHash("sha256");
    let offset = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      let bytesWritten = 0;
      while (bytesWritten < bytesRead) {
        const result = await target.write(
          buffer,
          bytesWritten,
          bytesRead - bytesWritten,
          offset + bytesWritten,
        );
        if (result.bytesWritten === 0) {
          throw new Error(`SQLite snapshot copy made no progress: ${targetPath}`);
        }
        bytesWritten += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await assertMutationFingerprintUnchanged(source, sourceFingerprint, targetPath);
    await target.sync();
    const currentIdentity = await fs.lstat(targetPath);
    if (!sameFileIdentity(targetIdentity, currentIdentity)) {
      throw new Error(`SQLite snapshot target changed during publication: ${targetPath}`);
    }
    return {
      content: { sha256: hash.digest("hex"), sizeBytes: offset },
      identity: currentIdentity,
    };
  } catch (error) {
    if (targetIdentity) {
      await target?.close().catch(() => undefined);
      target = undefined;
      removePublishedTargetIfOwned(targetPath, targetIdentity);
    }
    throw error;
  } finally {
    await target?.close().catch(() => undefined);
  }
}

type FileMutationFingerprint = Pick<
  BigIntStats,
  "birthtimeNs" | "ctimeNs" | "dev" | "ino" | "mtimeNs" | "size"
>;

async function readMutationFingerprint(handle: FileHandle): Promise<FileMutationFingerprint> {
  const stat = await handle.stat({ bigint: true });
  return {
    birthtimeNs: stat.birthtimeNs,
    ctimeNs: stat.ctimeNs,
    dev: stat.dev,
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
    size: stat.size,
  };
}

async function assertMutationFingerprintUnchanged(
  handle: FileHandle,
  expected: FileMutationFingerprint,
  filePath: string,
): Promise<void> {
  const current = await readMutationFingerprint(handle);
  if (
    current.birthtimeNs !== expected.birthtimeNs ||
    current.ctimeNs !== expected.ctimeNs ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.mtimeNs !== expected.mtimeNs ||
    current.size !== expected.size
  ) {
    throw new Error(`SQLite snapshot file changed while reading: ${filePath}`);
  }
}

function sameMutationFingerprint(
  left: FileMutationFingerprint,
  right: FileMutationFingerprint,
): boolean {
  return (
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size
  );
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertOpenFileIdentity(
  handle: FileHandle,
  filePath: string,
  expectedIdentity: Stats,
): Promise<void> {
  const openedIdentity = await handle.stat();
  const currentIdentity = await fs.lstat(filePath);
  if (
    !openedIdentity.isFile() ||
    !currentIdentity.isFile() ||
    !sameFileIdentity(expectedIdentity, openedIdentity) ||
    !sameFileIdentity(expectedIdentity, currentIdentity)
  ) {
    throw new Error(`SQLite snapshot file changed: ${filePath}`);
  }
}

async function hashPublishedFile(
  filePath: string,
  expectedIdentity: Stats,
): Promise<SqliteFileContent> {
  const handle = await fs.open(filePath, "r");
  try {
    return await hashOpenPublishedFile(handle, filePath, expectedIdentity);
  } finally {
    await handle.close();
  }
}

async function hashOpenPublishedFile(
  handle: FileHandle,
  filePath: string,
  expectedIdentity: Stats,
): Promise<SqliteFileContent> {
  await assertOpenFileIdentity(handle, filePath, expectedIdentity);
  const fingerprint = await readMutationFingerprint(handle);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const hash = createHash("sha256");
  let offset = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) {
      break;
    }
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  await assertMutationFingerprintUnchanged(handle, fingerprint, filePath);
  await assertOpenFileIdentity(handle, filePath, expectedIdentity);
  return { sha256: hash.digest("hex"), sizeBytes: offset };
}

function assertPublishedFileIdentitySync(filePath: string, expectedIdentity: Stats): void {
  const currentIdentity = fsSync.lstatSync(filePath);
  if (
    !currentIdentity.isFile() ||
    !sameFileIdentity(expectedIdentity, currentIdentity) ||
    expectedIdentity.size !== currentIdentity.size ||
    expectedIdentity.mtimeMs !== currentIdentity.mtimeMs ||
    expectedIdentity.ctimeMs !== currentIdentity.ctimeMs ||
    expectedIdentity.birthtimeMs !== currentIdentity.birthtimeMs
  ) {
    throw new Error(`SQLite snapshot file changed: ${filePath}`);
  }
}

function assertOpenFileIdentitySync(
  fileDescriptor: number,
  filePath: string,
  expectedIdentity: Stats,
): void {
  const openedIdentity = fsSync.fstatSync(fileDescriptor);
  const currentIdentity = fsSync.lstatSync(filePath);
  if (
    !openedIdentity.isFile() ||
    !currentIdentity.isFile() ||
    !sameFileIdentity(expectedIdentity, openedIdentity) ||
    !sameFileIdentity(expectedIdentity, currentIdentity)
  ) {
    throw new Error(`SQLite snapshot file changed: ${filePath}`);
  }
}

function hashPublishedFileSync(filePath: string, expectedIdentity: Stats): SqliteFileContent {
  const fileDescriptor = fsSync.openSync(filePath, "r");
  try {
    assertOpenFileIdentitySync(fileDescriptor, filePath, expectedIdentity);
    const initialStat = fsSync.fstatSync(fileDescriptor, { bigint: true });
    const initialFingerprint: FileMutationFingerprint = {
      birthtimeNs: initialStat.birthtimeNs,
      ctimeNs: initialStat.ctimeNs,
      dev: initialStat.dev,
      ino: initialStat.ino,
      mtimeNs: initialStat.mtimeNs,
      size: initialStat.size,
    };
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const bytesRead = fsSync.readSync(fileDescriptor, buffer, 0, buffer.length, offset);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const finalStat = fsSync.fstatSync(fileDescriptor, { bigint: true });
    const finalFingerprint: FileMutationFingerprint = {
      birthtimeNs: finalStat.birthtimeNs,
      ctimeNs: finalStat.ctimeNs,
      dev: finalStat.dev,
      ino: finalStat.ino,
      mtimeNs: finalStat.mtimeNs,
      size: finalStat.size,
    };
    if (!sameMutationFingerprint(initialFingerprint, finalFingerprint)) {
      throw new Error(`SQLite snapshot file changed while reading: ${filePath}`);
    }
    assertOpenFileIdentitySync(fileDescriptor, filePath, expectedIdentity);
    return { sha256: hash.digest("hex"), sizeBytes: offset };
  } finally {
    fsSync.closeSync(fileDescriptor);
  }
}

function assertExpectedContent(
  actual: SqliteFileContent,
  expected: SqliteFileContent,
  filePath: string,
): void {
  if (actual.sizeBytes !== expected.sizeBytes) {
    throw new Error(
      `SQLite snapshot size mismatch for ${filePath}: expected ${expected.sizeBytes}, got ${actual.sizeBytes}`,
    );
  }
  if (actual.sha256 !== expected.sha256) {
    throw new Error(
      `SQLite snapshot hash mismatch for ${filePath}: expected ${expected.sha256}, got ${actual.sha256}`,
    );
  }
}

function removePublishedTargetIfOwned(
  filePath: string,
  expectedIdentity: Stats,
  requireFingerprint = false,
): boolean {
  let currentIdentity: Stats;
  try {
    currentIdentity = fsSync.lstatSync(filePath);
  } catch {
    return false;
  }
  const fingerprintMatches =
    !requireFingerprint ||
    (expectedIdentity.size === currentIdentity.size &&
      expectedIdentity.mtimeMs === currentIdentity.mtimeMs &&
      expectedIdentity.ctimeMs === currentIdentity.ctimeMs &&
      expectedIdentity.birthtimeMs === currentIdentity.birthtimeMs);
  if (!sameFileIdentity(expectedIdentity, currentIdentity) || !fingerprintMatches) {
    return false;
  }
  // Node has no cross-platform unlink-by-inode primitive. Keep the ownership
  // check and unlink synchronous so no in-process task can replace the path.
  try {
    fsSync.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function assertSynchronousCallbackResult(result: unknown, label: string): void {
  if (
    result &&
    (typeof result === "object" || typeof result === "function") &&
    typeof (result as { then?: unknown }).then === "function"
  ) {
    void Promise.resolve(result).catch(() => undefined);
    throw new Error(`${label} must be synchronous.`);
  }
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    code === "ENOSYS" ||
    (process.platform === "win32" && (code === "EISDIR" || code === "EPERM" || code === "EACCES"))
  );
}

export async function syncDirectoryBestEffort(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, "r").catch((error: unknown) => {
    if (isUnsupportedDirectorySyncError(error)) {
      return undefined;
    }
    throw error;
  });
  if (!handle) {
    return;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function isLinkFallbackError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EPERM" ||
    code === "EXDEV" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "ENOSYS"
  );
}

/**
 * Publish the exact bytes of one already-verified SQLite file without reopening
 * its pathname during the copy. The target is always created exclusively.
 */
export async function publishVerifiedSqliteFile(
  options: PublishVerifiedSqliteFileOptions,
): Promise<void> {
  await assertTargetAbsent(options.targetPath);
  const targetDirectory = path.dirname(options.targetPath);
  const stagingDir = await createPrivateSqliteTempDirectory(
    targetDirectory,
    `.sqlite-publish-${randomUUID()}-`,
  );
  const stagedPath = path.join(stagingDir, "database.sqlite");
  let stagingIdentity: Stats | undefined;
  let source: FileHandle | undefined;
  let target: FileHandle | undefined;
  let targetPinFileDescriptor: number | undefined;
  let verifiedStagedIdentity: Stats | undefined;
  let linkedCandidateIdentity: Stats | undefined;
  let publishedIdentity: Stats | undefined;
  let ownershipPinned = false;
  let hardLinkCreated = false;
  try {
    stagingIdentity = await fs.lstat(stagingDir);
    await fs.chmod(stagingDir, 0o700);
    source = await fs.open(options.sourcePath, "r");
    await assertOpenFileIdentity(source, options.sourcePath, options.sourceIdentity);
    const staged = await copyFileExclusive(source, stagedPath);
    verifiedStagedIdentity = staged.identity;
    const expectedContent = options.expectedContent;
    assertExpectedContent(staged.content, expectedContent, options.targetPath);
    await source.close();
    source = undefined;

    await options.validatePublished?.(stagedPath);
    const validatedContent = await hashPublishedFile(stagedPath, staged.identity);
    assertExpectedContent(validatedContent, expectedContent, options.targetPath);
    await options.beforePublish?.();
    await assertTargetAbsent(options.targetPath);
    let usedHardLink = false;
    try {
      await fs.link(stagedPath, options.targetPath);
      usedHardLink = true;
      hardLinkCreated = true;
    } catch (error) {
      if (!isLinkFallbackError(error)) {
        throw error;
      }
      if (options.requireAtomicPublication) {
        throw new Error(
          `Atomic SQLite publication requires hard-link support in ${targetDirectory}.`,
          { cause: error },
        );
      }
      const stagedSource = await fs.open(stagedPath, "r");
      try {
        const copied = await copyFileExclusive(stagedSource, options.targetPath);
        publishedIdentity = copied.identity;
        assertExpectedContent(copied.content, expectedContent, options.targetPath);
      } finally {
        await stagedSource.close();
      }
    }
    if (usedHardLink) {
      target = await fs.open(options.targetPath, "r");
      const linkedIdentity = await target.stat();
      linkedCandidateIdentity = linkedIdentity;
      const currentTargetIdentity = await fs.lstat(options.targetPath);
      const currentStagedIdentity = await fs.lstat(stagedPath);
      if (!sameFileIdentity(linkedIdentity, currentTargetIdentity)) {
        throw new Error(`SQLite snapshot target changed during publication: ${options.targetPath}`);
      }
      const matchesVerifiedStaging = sameFileIdentity(staged.identity, linkedIdentity);
      const matchesCurrentStaging = sameFileIdentity(currentStagedIdentity, linkedIdentity);
      if (matchesVerifiedStaging || matchesCurrentStaging) {
        // The target handle pins exactly what link() published for ownership-safe cleanup.
        publishedIdentity = linkedIdentity;
        ownershipPinned = true;
      }
      if (!matchesCurrentStaging) {
        throw new Error(`SQLite snapshot staging path changed after publication: ${stagedPath}`);
      }
      if (!matchesVerifiedStaging) {
        throw new Error(
          `SQLite snapshot staging file changed during publication: ${options.targetPath}`,
        );
      }
    }
    if (!publishedIdentity) {
      throw new Error(`SQLite snapshot target was not published: ${options.targetPath}`);
    }
    const initialPublishedIdentity = publishedIdentity;
    target ??= await fs.open(options.targetPath, "r");
    await assertOpenFileIdentity(target, options.targetPath, initialPublishedIdentity);
    ownershipPinned = true;
    await syncDirectoryBestEffort(targetDirectory);
    await fs.unlink(stagedPath);
    const expectedIdentity = await target.stat();
    publishedIdentity = expectedIdentity;
    await fs.rmdir(stagingDir);
    await syncDirectoryBestEffort(targetDirectory);
    const linkedContent = await hashOpenPublishedFile(target, options.targetPath, expectedIdentity);
    assertExpectedContent(linkedContent, expectedContent, options.targetPath);
    await target.close();
    target = undefined;
    ownershipPinned = false;
    targetPinFileDescriptor = fsSync.openSync(options.targetPath, "r");
    assertOpenFileIdentitySync(targetPinFileDescriptor, options.targetPath, expectedIdentity);
    ownershipPinned = true;

    const guard: PublishedSqliteFileGuard = {
      assertTargetMatchesExpectedContent: (finalCheck) => {
        const content = hashPublishedFileSync(options.targetPath, expectedIdentity);
        assertExpectedContent(content, expectedContent, options.targetPath);
        assertSynchronousCallbackResult(finalCheck?.(), "SQLite publication final check");
        assertPublishedFileIdentitySync(options.targetPath, expectedIdentity);
      },
      assertTargetUnchanged: (finalCheck) => {
        assertPublishedFileIdentitySync(options.targetPath, expectedIdentity);
        assertSynchronousCallbackResult(finalCheck?.(), "SQLite publication final check");
        assertPublishedFileIdentitySync(options.targetPath, expectedIdentity);
      },
    };
    if (options.afterPublish) {
      assertSynchronousCallbackResult(
        options.afterPublish(guard),
        "SQLite after-publication guard",
      );
    } else {
      guard.assertTargetUnchanged();
    }
    fsSync.closeSync(targetPinFileDescriptor);
    targetPinFileDescriptor = undefined;
    ownershipPinned = false;
  } catch (error) {
    if (!publishedIdentity && hardLinkCreated && verifiedStagedIdentity) {
      const currentTargetIdentity = await fs.lstat(options.targetPath).catch(() => undefined);
      const currentStagedIdentity = await fs.lstat(stagedPath).catch(() => undefined);
      const targetMatchesStaging =
        currentTargetIdentity &&
        currentStagedIdentity &&
        sameFileIdentity(currentTargetIdentity, currentStagedIdentity);
      const targetMatchesVerified =
        currentTargetIdentity && sameFileIdentity(currentTargetIdentity, verifiedStagedIdentity);
      if (targetMatchesStaging || targetMatchesVerified) {
        publishedIdentity = currentTargetIdentity;
        ownershipPinned = Boolean(targetMatchesStaging);
      }
    }
    if (!publishedIdentity && target && linkedCandidateIdentity && verifiedStagedIdentity) {
      const currentTargetIdentity = await fs.lstat(options.targetPath).catch(() => undefined);
      const currentStagedIdentity = await fs.lstat(stagedPath).catch(() => undefined);
      const targetStillMatches =
        currentTargetIdentity && sameFileIdentity(currentTargetIdentity, linkedCandidateIdentity);
      const targetCameFromStaging =
        (currentStagedIdentity &&
          sameFileIdentity(currentStagedIdentity, linkedCandidateIdentity)) ||
        sameFileIdentity(verifiedStagedIdentity, linkedCandidateIdentity);
      if (targetStillMatches && targetCameFromStaging) {
        publishedIdentity = linkedCandidateIdentity;
        ownershipPinned = true;
      }
    }
    if (target && publishedIdentity) {
      const openedIdentity = await target.stat().catch(() => undefined);
      if (openedIdentity && sameFileIdentity(openedIdentity, publishedIdentity)) {
        publishedIdentity = openedIdentity;
        ownershipPinned = true;
      }
    }
    if (publishedIdentity) {
      const removed = removePublishedTargetIfOwned(
        options.targetPath,
        publishedIdentity,
        !ownershipPinned,
      );
      if (removed) {
        await syncDirectoryBestEffort(targetDirectory).catch(() => undefined);
      }
    }
    if (stagingIdentity) {
      await removePublicationStagingDirectory(stagingDir, stagingIdentity).catch(() => undefined);
    } else {
      await fs.rmdir(stagingDir).catch(() => undefined);
    }
    throw error;
  } finally {
    if (targetPinFileDescriptor !== undefined) {
      fsSync.closeSync(targetPinFileDescriptor);
    }
    if (target) {
      await target.close().catch(() => undefined);
    }
    if (source) {
      await source.close().catch(() => undefined);
    }
  }
}

async function removePublicationStagingDirectory(
  stagingDir: string,
  expectedIdentity: Stats,
): Promise<void> {
  const currentIdentity = await fs.lstat(stagingDir).catch(() => undefined);
  if (!currentIdentity) {
    return;
  }
  if (!currentIdentity.isDirectory() || !sameFileIdentity(expectedIdentity, currentIdentity)) {
    throw new Error(`SQLite publication staging directory changed: ${stagingDir}`);
  }
  const entries = await fs.readdir(stagingDir, { withFileTypes: true });
  if (
    entries.length > 1 ||
    entries.some((entry) => entry.name !== "database.sqlite" || !entry.isFile())
  ) {
    throw new Error(`SQLite publication staging directory has unexpected contents: ${stagingDir}`);
  }
  const stagedEntry = entries[0];
  if (stagedEntry) {
    await fs.unlink(path.join(stagingDir, stagedEntry.name));
  }
  await fs.rmdir(stagingDir);
}

/**
 * Compact one SQLite database into a fresh private file and verify the result.
 *
 * The source and output both receive full structural, index, and foreign-key
 * checks. Only a fully verified, synced snapshot is published to the target.
 */
export async function createVerifiedSqliteSnapshot(
  options: CreateVerifiedSqliteSnapshotOptions,
): Promise<VerifiedSqliteSnapshot> {
  await assertRegularSourceFile(options.sourcePath, options.requireNonEmptySource === true);
  await assertTargetAbsent(options.targetPath);

  const stagingDir = await createPrivateSqliteTempDirectory(
    path.dirname(options.targetPath),
    ".sqlite-snapshot-",
  );
  await fs.chmod(stagingDir, 0o700);
  const stagedPath = path.join(stagingDir, "database.sqlite");
  const sqlite = requireNodeSqlite();
  let stagedIdentity: Stats | undefined;
  try {
    const source = new sqlite.DatabaseSync(resolveSqliteFilesystemPath(options.sourcePath), {
      allowExtension: true,
      readOnly: true,
    });
    try {
      source.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF;");
      await loadSqliteVecExtension({ db: source });
      assertSqliteIntegrity(source, options.sourcePath);
      options.validate?.(source, options.sourcePath);
      source.prepare("VACUUM INTO ?").run(resolveSqliteFilesystemPath(stagedPath));
    } finally {
      source.close();
    }

    await fs.chmod(stagedPath, 0o600);
    const snapshot = new sqlite.DatabaseSync(resolveSqliteFilesystemPath(stagedPath), {
      allowExtension: true,
    });
    try {
      snapshot.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF;");
      await loadSqliteVecExtension({ db: snapshot });
      if (options.transform) {
        await options.transform(snapshot);
        // A transform may delete sensitive rows. Compact again so the
        // published artifact cannot retain their bytes in free pages.
        snapshot.exec("VACUUM;");
      }
      assertSqliteIntegrity(snapshot, options.targetPath);
      options.validate?.(snapshot, options.targetPath);
      const userVersion = readSqliteUserVersion(snapshot);
      snapshot.close();
      await syncFile(stagedPath);
      stagedIdentity = await fs.lstat(stagedPath);
      const expectedContent = await hashPublishedFile(stagedPath, stagedIdentity);
      await publishVerifiedSqliteFile({
        sourceIdentity: stagedIdentity,
        sourcePath: stagedPath,
        targetPath: options.targetPath,
        expectedContent,
        beforePublish: options.beforePublish,
        afterPublish: options.afterPublish,
        validatePublished: async (publishedPath) => {
          const published = new sqlite.DatabaseSync(resolveSqliteFilesystemPath(publishedPath), {
            allowExtension: true,
            readOnly: true,
          });
          try {
            published.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF;");
            await loadSqliteVecExtension({ db: published });
            assertSqliteIntegrity(published, options.targetPath);
            options.validate?.(published, options.targetPath);
            const publishedUserVersion = readSqliteUserVersion(published);
            if (publishedUserVersion !== userVersion) {
              throw new Error(
                `SQLite snapshot user_version changed during publication: expected ${userVersion}, got ${publishedUserVersion}`,
              );
            }
          } finally {
            published.close();
          }
        },
      });
      return { path: options.targetPath, userVersion };
    } finally {
      if (snapshot.isOpen) {
        snapshot.close();
      }
    }
  } catch (error) {
    throw new Error(
      `SQLite database cannot be snapshotted safely: ${options.sourcePath}. ${formatErrorMessage(error)}`,
      { cause: error },
    );
  } finally {
    await fs.rm(stagingDir, { force: true, recursive: true }).catch(() => undefined);
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
