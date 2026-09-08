// Reads PID-reuse-safe Windows process start identities without workspace imports.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveDiagnosticProcessEnv, resolveEnvironmentValue } from "./process-env.ts";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_PROCESS_START_TIMEOUT_MS = 10_000;
const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  const configured =
    resolveEnvironmentValue(env, "SystemRoot", "win32") ??
    resolveEnvironmentValue(env, "WINDIR", "win32");
  if (!configured) {
    return DEFAULT_WINDOWS_SYSTEM_ROOT;
  }
  const normalized = path.win32.normalize(configured);
  return /^[A-Za-z]:\\/.test(normalized) && !normalized.startsWith("\\\\")
    ? normalized
    : DEFAULT_WINDOWS_SYSTEM_ROOT;
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return path.win32.join(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsWmicPath(env: NodeJS.ProcessEnv): string {
  return path.win32.join(windowsSystemRoot(env), "System32", "wbem", "wmic.exe");
}

export function decodeWindowsProcessOutput(output: Buffer | string): string {
  if (!Buffer.isBuffer(output)) {
    return output;
  }
  return output.length >= 2 && output[0] === 0xff && output[1] === 0xfe
    ? output.toString("utf16le")
    : output.toString("utf8");
}

function parseWindowsProcessStartTime(raw: Buffer | string): number | null {
  const lines = decodeWindowsProcessOutput(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const value =
    lines
      .find((line) => line.toLowerCase().startsWith("creationdate="))
      ?.slice("creationdate=".length)
      .trim() ??
    lines.find((line) => line.toLowerCase() !== "creationdate") ??
    "";
  const parsedIso = Date.parse(value);
  if (Number.isFinite(parsedIso)) {
    return parsedIso;
  }
  const dmtf = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/);
  if (!dmtf) {
    return null;
  }
  const [, year, month, day, hour, minute, second, microseconds, offsetSign, offset] = dmtf;
  const localTimeMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Math.floor(Number(microseconds) / 1000),
  );
  const offsetMs = Number(offset) * 60_000 * (offsetSign === "+" ? 1 : -1);
  return localTimeMs - offsetMs;
}

/** Read a stable Windows process creation time for lock-owner identity checks. */
export function readWindowsProcessStartTimeSync(
  pid: number,
  timeoutMs = DEFAULT_PROCESS_START_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  // Preserve both former 5s attempts inside one deadline. Explicit callers
  // still keep their smaller end-to-end budget.
  const deadline = Date.now() + timeoutMs;
  const powershell = spawnSync(
    windowsPowerShellPath(env),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      // Read the kernel timestamp without CIM module discovery consuming the
      // caller's short ownership-query budget. Dispose the opened process handle.
      `$process = [System.Diagnostics.Process]::GetProcessById(${pid}); try { [Console]::Out.Write($process.StartTime.ToUniversalTime().ToString("o")) } finally { $process.Dispose() }`,
    ],
    {
      encoding: "utf8",
      env: resolveDiagnosticProcessEnv(env, "win32"),
      timeout: Math.min(timeoutMs, DEFAULT_TIMEOUT_MS),
      windowsHide: true,
    },
  );
  if (!powershell.error && powershell.status === 0) {
    const startTime = parseWindowsProcessStartTime(powershell.stdout);
    if (startTime !== null) {
      return startTime;
    }
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return null;
  }
  const wmic = spawnSync(
    windowsWmicPath(env),
    ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"],
    {
      env: resolveDiagnosticProcessEnv(env, "win32"),
      timeout: remainingMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return !wmic.error && wmic.status === 0 ? parseWindowsProcessStartTime(wmic.stdout) : null;
}
