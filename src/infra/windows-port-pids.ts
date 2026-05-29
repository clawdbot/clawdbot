import { spawnSync } from "node:child_process";
import { parseCmdScriptCommandLine } from "../daemon/cmd-argv.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { parseStrictPositiveInteger } from "./parse-finite-number.js";

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
    "powershell",
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
  const pids = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match) {
      continue;
    }
    const parsedPort = Number.parseInt(match[2] ?? "", 10);
    const pid = Number.parseInt(match[3] ?? "", 10);
    if (parsedPort === port && Number.isFinite(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
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
  const netstat = spawnSync("netstat", ["-ano", "-p", "tcp"], {
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
// Windows process-args reading (PowerShell → WMIC fallback)
// ---------------------------------------------------------------------------

function extractWindowsCommandLine(raw: string): string | null {
  const lines = normalizeStringEntries(raw.split(/\r?\n/));
  for (const line of lines) {
    if (!normalizeLowercaseStringOrEmpty(line).startsWith("commandline=")) {
      continue;
    }
    const value = line.slice("commandline=".length).trim();
    return value || null;
  }
  return lines.find((line) => normalizeLowercaseStringOrEmpty(line) !== "commandline") ?? null;
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
    "powershell",
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
    "wmic",
    ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    },
  );
  if (!wmic.error && wmic.status === 0) {
    const command = extractWindowsCommandLine(wmic.stdout);
    return { ok: true, args: command ? parseCmdScriptCommandLine(command) : null };
  }
  const code = ((wmic.error ?? powershell.error) as NodeJS.ErrnoException | undefined)?.code;
  return { ok: false, permanent: code === "ENOENT" || code === "EACCES" || code === "EPERM" };
}
