import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import {
  buildEncodedPowerShellArgs,
  buildPowerShellFailureCause,
  WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
} from "../infra/windows-powershell-spawn.js";
import { runExec } from "../process/exec.js";
import {
  resolveTrustedPlanDirectoryPath,
  resolveTrustedWindowsSystemExecutablePath,
} from "./trusted-plan-path.js";

type WindowsPrivatePlanFileDependencies = {
  resolveCompilerTempDir?: (env: NodeJS.ProcessEnv) => Promise<string>;
  resolveTrustedExecutable?: (targetPath: string) => Promise<string>;
  run?: typeof runExec;
};

const WINDOWS_PLAN_FILE_EXISTS_MARKER = "PRIVATE_PLAN_FILE_EXISTS";
const WINDOWS_PRIVATE_PLAN_FILE_NATIVE_SOURCE = `
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class OpenClawPrivatePlanFile : IDisposable
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
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        ref SecurityAttributes securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(
        SafeFileHandle file,
        byte[] buffer,
        uint bytesToWrite,
        out uint bytesWritten,
        IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FlushFileBuffers(SafeFileHandle file);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileExW(
        string existingFileName,
        string newFileName,
        uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool DeleteFileW(string fileName);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInfo
    {
        [MarshalAs(UnmanagedType.Bool)]
        public bool DeleteFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle file,
        int fileInformationClass,
        ref FileDispositionInfo fileInformation,
        uint bufferSize);

    private readonly string stagingPath;
    private readonly string finalPath;
    private SafeFileHandle handle;

    private OpenClawPrivatePlanFile(
        string stagingPath,
        string finalPath,
        SafeFileHandle handle)
    {
        this.stagingPath = stagingPath;
        this.finalPath = finalPath;
        this.handle = handle;
    }

    private static bool SetDeleteOnClose(SafeFileHandle handle, bool enabled)
    {
        var disposition = new FileDispositionInfo { DeleteFile = enabled };
        return SetFileInformationByHandle(
            handle,
            4,
            ref disposition,
            (uint)Marshal.SizeOf(typeof(FileDispositionInfo)));
    }

    public static OpenClawPrivatePlanFile Open(
        string stagingPath,
        string finalPath,
        string securityDescriptor,
        out int errorCode)
    {
        errorCode = 0;
        IntPtr descriptor;
        uint descriptorSize;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                securityDescriptor,
                1,
                out descriptor,
                out descriptorSize))
        {
            errorCode = Marshal.GetLastWin32Error();
            return null;
        }

        try
        {
            var attributes = new SecurityAttributes
            {
                Length = Marshal.SizeOf(typeof(SecurityAttributes)),
                SecurityDescriptor = descriptor,
                InheritHandle = 0,
            };
            var handle = CreateFileW(stagingPath, 0x40010000, 0, ref attributes, 1, 0x80, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                errorCode = Marshal.GetLastWin32Error();
                handle.Dispose();
                return null;
            }
            return new OpenClawPrivatePlanFile(stagingPath, finalPath, handle);
        }
        finally
        {
            LocalFree(descriptor);
        }
    }

    public int ArmDeleteOnClose()
    {
        if (handle == null || handle.IsInvalid || handle.IsClosed)
        {
            return 6;
        }
        if (SetDeleteOnClose(handle, true))
        {
            return 0;
        }
        var dispositionError = Marshal.GetLastWin32Error();
        handle.Dispose();
        handle = null;
        DeleteFileW(stagingPath);
        return dispositionError == 0 ? 29 : dispositionError;
    }

    public int WriteAndPublish(byte[] content)
    {
        if (handle == null || handle.IsInvalid || handle.IsClosed)
        {
            return 6;
        }
        uint written;
        if (content.Length > 0 &&
            (!WriteFile(handle, content, (uint)content.Length, out written, IntPtr.Zero) ||
             written != (uint)content.Length))
        {
            var writeError = Marshal.GetLastWin32Error();
            return writeError == 0 ? 29 : writeError;
        }
        if (!FlushFileBuffers(handle))
        {
            var flushError = Marshal.GetLastWin32Error();
            return flushError == 0 ? 29 : flushError;
        }
        if (!SetDeleteOnClose(handle, false))
        {
            var dispositionError = Marshal.GetLastWin32Error();
            return dispositionError == 0 ? 29 : dispositionError;
        }
        handle.Dispose();
        handle = null;
        if (MoveFileExW(stagingPath, finalPath, 0x8))
        {
            return 0;
        }
        var moveError = Marshal.GetLastWin32Error();
        DeleteFileW(stagingPath);
        return moveError == 0 ? 29 : moveError;
    }

    public void Dispose()
    {
        if (handle != null)
        {
            var openHandle = handle;
            handle = null;
            var deletePending = SetDeleteOnClose(openHandle, true);
            openHandle.Dispose();
            if (!deletePending)
            {
                DeleteFileW(stagingPath);
            }
        }
    }
}
`;

function readWindowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.entries(env).find(([key]) => key.toLowerCase() === lower)?.[1];
}

async function resolvePrivateWindowsCompilerTempDir(env: NodeJS.ProcessEnv): Promise<string> {
  const candidate = readWindowsEnv(env, "TEMP") ?? readWindowsEnv(env, "TMP");
  if (!candidate || !path.win32.isAbsolute(candidate)) {
    throw new Error(
      "Unable to resolve an absolute Windows temp directory for private plan creation.",
    );
  }
  return await resolveTrustedPlanDirectoryPath(candidate);
}

async function resolveTrustedPowerShell(targetPath: string): Promise<string> {
  const powershell = resolveSystemBin("powershell");
  if (!powershell || powershell.toLowerCase() !== targetPath.toLowerCase()) {
    throw new Error("Unable to resolve trusted Windows PowerShell for private plan creation.");
  }
  return await resolveTrustedWindowsSystemExecutablePath(targetPath);
}

export async function createPrivateWindowsPlanFile(
  filePath: string,
  content: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: WindowsPrivatePlanFileDependencies = {},
): Promise<void> {
  const resolveTrustedExecutable =
    dependencies.resolveTrustedExecutable ?? resolveTrustedPowerShell;
  const resolveCompilerTempDir =
    dependencies.resolveCompilerTempDir ?? resolvePrivateWindowsCompilerTempDir;
  const run = dependencies.run ?? runExec;
  const systemRoot =
    readWindowsEnv(env, "SYSTEMROOT") ?? readWindowsEnv(env, "WINDIR") ?? "C:\\Windows";
  if (!path.win32.isAbsolute(systemRoot)) {
    throw new Error("Unable to resolve the Windows system directory for private plan creation.");
  }
  const resolvedPath = path.resolve(filePath);
  const stagingPath = path.join(path.dirname(resolvedPath), `.openclaw-plan-${randomUUID()}.tmp`);
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))",
    "$payload = $payloadJson | ConvertFrom-Json",
    "Add-Type -TypeDefinition $payload.nativeSource -Language CSharp",
    "$finalPath = $payload.finalPath",
    "$stagingPath = $payload.stagingPath",
    "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$security = New-Object System.Security.AccessControl.FileSecurity",
    "$security.SetAccessRuleProtection($true, $false)",
    "$security.SetOwner($current)",
    "$expected = @($current.Value, 'S-1-5-18') | Sort-Object -Unique",
    "foreach ($sidValue in $expected) { $sid = New-Object System.Security.Principal.SecurityIdentifier($sidValue); $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow); [void]$security.AddAccessRule($rule) }",
    "$sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access",
    "$sddl = $security.GetSecurityDescriptorSddlForm($sections)",
    "$content = [Convert]::FromBase64String($payload.content)",
    "$openError = 0",
    "$native = [OpenClawPrivatePlanFile]::Open($stagingPath, $finalPath, $sddl, [ref]$openError)",
    "$errorCode = $openError",
    "if ($null -ne $native) { try { $actual = Get-Acl -LiteralPath $stagingPath; $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); if (!$actual.AreAccessRulesProtected -or $rules.Count -ne $expected.Count) { throw 'private plan ACL verification failed' }; foreach ($rule in $rules) { if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $expected -notcontains $rule.IdentityReference.Value -or ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'private plan ACL verification failed' } }; $errorCode = $native.ArmDeleteOnClose(); if ($errorCode -eq 0) { $errorCode = $native.WriteAndPublish($content) } } finally { $native.Dispose() } }",
    `if ($errorCode -eq 80 -or $errorCode -eq 183) { throw '${WINDOWS_PLAN_FILE_EXISTS_MARKER}' }`,
    "if ($errorCode -ne 0) { $exception = New-Object System.ComponentModel.Win32Exception($errorCode); throw $exception }",
  ].join("; ");
  const powershellCandidate = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const powershell = await resolveTrustedExecutable(powershellCandidate);
  const compilerTempDir = await resolveCompilerTempDir(env);
  const input = Buffer.from(
    JSON.stringify({
      content: Buffer.from(content, "utf8").toString("base64"),
      finalPath: path.toNamespacedPath(resolvedPath),
      nativeSource: WINDOWS_PRIVATE_PLAN_FILE_NATIVE_SOURCE,
      stagingPath: path.toNamespacedPath(stagingPath),
    }),
    "utf8",
  ).toString("base64");
  try {
    await run(powershell, buildEncodedPowerShellArgs(command), {
      baseEnv: {},
      env: {
        SYSTEMROOT: systemRoot,
        TEMP: compilerTempDir,
        TMP: compilerTempDir,
        WINDIR: systemRoot,
      },
      input,
      logOutput: false,
      maxBuffer: 64 * 1024,
      timeoutMs: WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
    });
  } catch (error) {
    if (String(error).includes(WINDOWS_PLAN_FILE_EXISTS_MARKER)) {
      const existsError = new Error(`Private plan file already exists: ${filePath}`);
      (existsError as NodeJS.ErrnoException).code = "EEXIST";
      throw existsError;
    }
    // oxlint-disable-next-line preserve-caught-error -- The raw error carries the -EncodedCommand argv; only the sanitized bounded diagnostic may escape.
    throw new Error(`Unable to create private Windows plan file: ${filePath}`, {
      cause: buildPowerShellFailureCause(error),
    });
  }
}
