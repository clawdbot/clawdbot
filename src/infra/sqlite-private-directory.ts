// Creates private SQLite staging directories without pulling higher-level runtime modules.
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSystemBin } from "./resolve-system-bin.js";
import { decodeWindowsOutputBuffer } from "./windows-encoding.js";
import {
  buildEncodedPowerShellArgs,
  buildPowerShellFailureCause,
  sanitizePowerShellOutputText,
  WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
} from "./windows-powershell-spawn.js";

const SQLITE_DIRECTORY_MODE = 0o700;
const WINDOWS_DIRECTORY_EXISTS_MARKER = "OPENCLAW_SQLITE_DIRECTORY_EXISTS";

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

function failureText(value: unknown): string {
  const text = Buffer.isBuffer(value)
    ? decodeWindowsOutputBuffer({ buffer: value })
    : typeof value === "string"
      ? value
      : "";
  return sanitizePowerShellOutputText(text);
}

function privateDirectoryError(
  directoryPath: string,
  error: unknown,
  stdout?: unknown,
  stderr?: unknown,
): Error {
  const failure = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  if (
    [error, stderr, stdout, failure.stderr, failure.stdout].some((value) =>
      String(value).includes(WINDOWS_DIRECTORY_EXISTS_MARKER),
    )
  ) {
    const existsError = new Error(`Private SQLite directory already exists: ${directoryPath}`);
    (existsError as NodeJS.ErrnoException).code = "EEXIST";
    return existsError;
  }
  const cause = buildPowerShellFailureCause({
    status: failure.status,
    code: failure.code,
    killed: failure.killed,
    signal: failure.signal,
    stderr: failureText(stderr) || failureText(failure.stderr),
    stdout: failureText(stdout) || failureText(failure.stdout),
  });
  return new Error(`Unable to create private Windows SQLite directory: ${directoryPath}`, {
    cause,
  });
}

function runPrivateDirectoryPowerShell(
  directoryPath: string,
  powershell: string,
  args: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      powershell,
      args,
      {
        encoding: "buffer",
        maxBuffer: 64 * 1024,
        timeout: WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(privateDirectoryError(directoryPath, error, stdout, stderr));
          return;
        }
        resolve();
      },
    );
  });
}

function resolvePrivateDirectoryPowerShell(directoryPath: string): {
  args: string[];
  powershell: string;
} {
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
  return {
    powershell,
    args: buildEncodedPowerShellArgs(command),
  };
}

export async function createPrivateSqliteDirectory(directoryPath: string): Promise<void> {
  if (process.platform !== "win32") {
    await fs.mkdir(directoryPath, { mode: SQLITE_DIRECTORY_MODE });
    return;
  }
  // This raw Win32 call bypasses Node's automatic long-path normalization.
  const { args, powershell } = resolvePrivateDirectoryPowerShell(directoryPath);
  await runPrivateDirectoryPowerShell(directoryPath, powershell, args);
}

function createPrivateSqliteDirectorySync(directoryPath: string): void {
  if (process.platform !== "win32") {
    fsSync.mkdirSync(directoryPath, { mode: SQLITE_DIRECTORY_MODE });
    return;
  }
  const { args, powershell } = resolvePrivateDirectoryPowerShell(directoryPath);
  try {
    execFileSync(powershell, args, {
      maxBuffer: 64 * 1024,
      timeout: WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (error) {
    throw privateDirectoryError(directoryPath, error);
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

export function createPrivateSqliteTempDirectorySync(rootPath: string, prefix: string): string {
  if (process.platform !== "win32") {
    return fsSync.mkdtempSync(path.join(rootPath, prefix));
  }
  const directoryPath = path.join(rootPath, `${prefix}${randomUUID()}`);
  createPrivateSqliteDirectorySync(directoryPath);
  return directoryPath;
}
