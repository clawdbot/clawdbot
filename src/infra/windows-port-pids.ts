// Resolves Windows process identity and listening-port ownership.
import { spawnSync } from "node:child_process";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { parseCmdScriptCommandLine } from "../daemon/cmd-argv.js";
import { parseStrictPositiveInteger } from "./parse-finite-number.js";
import { parseWindowsNetstatListeners } from "./ports-netstat.js";
import {
  getWindowsPowerShellExePath,
  getWindowsSystem32ExePath,
  getWindowsWmicExePath,
} from "./windows-install-roots.js";

const DEFAULT_TIMEOUT_MS = 5_000;

export type WindowsListeningPidsResult =
  | { ok: true; pids: number[] }
  | { ok: false; permanent: boolean };

export type WindowsProcessArgsResult =
  | { ok: true; args: string[] | null }
  | { ok: false; permanent: boolean };

// ---------------------------------------------------------------------------
// Windows listening-PID discovery (PowerShell → netstat fallback)
// ---------------------------------------------------------------------------

function readListeningPidsViaPowerShell(port: number, timeoutMs: number): number[] | null {
  const ps = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)`,
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    },
  );
  if (ps.error || ps.status !== 0) {
    return null;
  }
  return ps.stdout.split(/\r?\n/).flatMap((line) => parseStrictPositiveInteger(line.trim()) ?? []);
}

function parseListeningPidsFromNetstat(stdout: string, port: number): number[] {
  return [...new Set(parseWindowsNetstatListeners(stdout, port).map((listener) => listener.pid))];
}

export function readWindowsListeningPidsOnPortSync(
  port: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): number[] {
  const result = readWindowsListeningPidsResultSync(port, timeoutMs);
  return result.ok ? result.pids : [];
}

export function readWindowsListeningPidsResultSync(
  port: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): WindowsListeningPidsResult {
  const powershellPids = readListeningPidsViaPowerShell(port, timeoutMs);
  if (powershellPids != null) {
    return { ok: true, pids: powershellPids };
  }
  const netstat = spawnSync(getWindowsSystem32ExePath("netstat.exe"), ["-ano"], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (netstat.error) {
    const code = (netstat.error as NodeJS.ErrnoException).code;
    return { ok: false, permanent: code === "ENOENT" || code === "EACCES" || code === "EPERM" };
  }
  if (netstat.status !== 0) {
    return { ok: false, permanent: false };
  }
  return { ok: true, pids: parseListeningPidsFromNetstat(netstat.stdout, port) };
}

// ---------------------------------------------------------------------------
// Windows process identity reading (PowerShell → WMIC fallback)
// ---------------------------------------------------------------------------

function decodeWindowsProcessOutput(output: Buffer | string): string {
  if (!Buffer.isBuffer(output)) {
    return output;
  }
  return output.length >= 2 && output[0] === 0xff && output[1] === 0xfe
    ? output.toString("utf16le")
    : output.toString("utf8");
}

function extractWindowsCommandLine(raw: Buffer | string): string | null {
  const lines = normalizeStringEntries(decodeWindowsProcessOutput(raw).split(/\r?\n/));
  for (const line of lines) {
    if (!normalizeLowercaseStringOrEmpty(line).startsWith("commandline=")) {
      continue;
    }
    const value = line.slice("commandline=".length).trim();
    return value || null;
  }
  return lines.find((line) => normalizeLowercaseStringOrEmpty(line) !== "commandline") ?? null;
}

function parseWindowsProcessStartTime(raw: Buffer | string): number | null {
  const lines = normalizeStringEntries(decodeWindowsProcessOutput(raw).split(/\r?\n/));
  const value =
    lines
      .find((line) => normalizeLowercaseStringOrEmpty(line).startsWith("creationdate="))
      ?.slice("creationdate=".length)
      .trim() ??
    lines.find((line) => normalizeLowercaseStringOrEmpty(line) !== "creationdate") ??
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
  timeoutMs = DEFAULT_TIMEOUT_MS,
): number | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const powershell = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop; [Console]::Out.Write($process.CreationDate.ToUniversalTime().ToString("o"))`,
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    },
  );
  if (!powershell.error && powershell.status === 0) {
    const startTime = parseWindowsProcessStartTime(powershell.stdout);
    if (startTime !== null) {
      return startTime;
    }
  }
  const wmic = spawnSync(
    getWindowsWmicExePath(),
    ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"],
    {
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return !wmic.error && wmic.status === 0 ? parseWindowsProcessStartTime(wmic.stdout) : null;
}

export function readWindowsProcessArgsSync(
  pid: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): string[] | null {
  const result = readWindowsProcessArgsResultSync(pid, timeoutMs);
  return result.ok ? result.args : null;
}

export function readWindowsProcessArgsResultSync(
  pid: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): WindowsProcessArgsResult {
  const powershell = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine)`,
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    },
  );
  if (!powershell.error && powershell.status === 0) {
    const command = powershell.stdout.trim();
    return { ok: true, args: command ? parseCmdScriptCommandLine(command) : null };
  }
  const wmic = spawnSync(
    getWindowsWmicExePath(),
    ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"],
    {
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (!wmic.error && wmic.status === 0) {
    const command = extractWindowsCommandLine(wmic.stdout);
    return { ok: true, args: command ? parseCmdScriptCommandLine(command) : null };
  }
  const code = ((wmic.error ?? powershell.error) as NodeJS.ErrnoException | undefined)?.code;
  return { ok: false, permanent: code === "ENOENT" || code === "EACCES" || code === "EPERM" };
}
