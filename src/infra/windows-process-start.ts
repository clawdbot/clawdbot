// Reads PID-reuse-safe Windows process start identities without workspace imports.
import { spawnSync } from "node:child_process";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_PROCESS_START_TIMEOUT_MS = 10_000;
const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";

function windowsSystemRoot(): string {
  const configured = process.env.SystemRoot ?? process.env.WINDIR;
  if (!configured) {
    return DEFAULT_WINDOWS_SYSTEM_ROOT;
  }
  const normalized = path.win32.normalize(configured);
  return /^[A-Za-z]:\\/.test(normalized) && !normalized.startsWith("\\\\")
    ? normalized
    : DEFAULT_WINDOWS_SYSTEM_ROOT;
}

function windowsPowerShellPath(): string {
  return path.win32.join(
    windowsSystemRoot(),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsWmicPath(): string {
  return path.win32.join(windowsSystemRoot(), "System32", "wbem", "wmic.exe");
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
): number | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  // Preserve both former 5s attempts inside one deadline. Explicit callers
  // still keep their smaller end-to-end budget.
  const deadline = Date.now() + timeoutMs;
  const powershell = spawnSync(
    windowsPowerShellPath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop; [Console]::Out.Write($process.CreationDate.ToUniversalTime().ToString("o"))`,
    ],
    {
      encoding: "utf8",
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
    windowsWmicPath(),
    ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"],
    {
      timeout: remainingMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return !wmic.error && wmic.status === 0 ? parseWindowsProcessStartTime(wmic.stdout) : null;
}
