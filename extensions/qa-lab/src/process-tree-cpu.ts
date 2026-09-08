// Qa Lab plugin module implements process tree cpu behavior.
import { spawnSync } from "node:child_process";
import {
  asNonNegativeFiniteNumber,
  parseStrictFiniteNumber,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "openclaw/plugin-sdk/number-runtime";
import { isRecord as isPlainObject } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveQaWindowsPowerShellExePath } from "./windows-system-tools.js";

type ProcessTreeSnapshot = {
  childrenByParent: Map<number, number[]>;
  cpuByPid: Map<number, number>;
  rssByPid: Map<number, number>;
};

const PROCESS_TREE_SNAPSHOT_TIMEOUT_MS = 5_000;

function parsePsCpuTimeMs(raw: string): number | null {
  const match = raw.trim().match(/^(?:(\d+)-)?(\d+):(\d{2}(?:\.\d+)?)(?::(\d{2}(?:\.\d+)?))?$/u);
  if (!match) {
    return null;
  }
  const [, daysRaw, firstRaw, secondRaw, thirdRaw] = match;
  if (daysRaw !== undefined && thirdRaw === undefined) {
    return null;
  }
  const days = daysRaw === undefined ? 0 : Number(daysRaw);
  const first = Number(firstRaw);
  const second = Number(secondRaw);
  const third = thirdRaw === undefined ? 0 : Number(thirdRaw);
  const values = [days, first, second, third];
  if (values.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  if (thirdRaw !== undefined && !Number.isInteger(second)) {
    return null;
  }
  if (second >= 60 || (thirdRaw !== undefined && third >= 60)) {
    return null;
  }
  if (daysRaw !== undefined && thirdRaw !== undefined) {
    return Math.round((days * 24 * 60 * 60 + first * 60 * 60 + second * 60 + third) * 1000);
  }
  if (thirdRaw !== undefined) {
    return Math.round((first * 60 * 60 + second * 60 + third) * 1000);
  }
  return Math.round((first * 60 + second) * 1000);
}

function parsePsRssBytes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const rssKiB = parseStrictFiniteNumber(trimmed);
  if (rssKiB === undefined || rssKiB < 0) {
    return null;
  }
  return Math.round(rssKiB * 1024);
}

function parseWindowsProcessCpuTimeMs(params: {
  kernelModeTime: unknown;
  userModeTime: unknown;
}): number | null {
  const kernelModeTime = asNonNegativeFiniteNumber(parseStrictFiniteNumber(params.kernelModeTime));
  const userModeTime = asNonNegativeFiniteNumber(parseStrictFiniteNumber(params.userModeTime));
  if (kernelModeTime === undefined || userModeTime === undefined) {
    return null;
  }
  return Math.round((kernelModeTime + userModeTime) / 10_000);
}

function parseWindowsWorkingSetBytes(raw: unknown): number | null {
  const parsed = asNonNegativeFiniteNumber(parseStrictFiniteNumber(raw));
  return parsed === undefined ? null : Math.round(parsed);
}

function parseWindowsProcessTreeSnapshot(raw: string): ProcessTreeSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed) ? parsed : isPlainObject(parsed) ? [parsed] : [];
  if (entries.length === 0) {
    return null;
  }

  const childrenByParent = new Map<number, number[]>();
  const cpuByPid = new Map<number, number>();
  const rssByPid = new Map<number, number>();
  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const pid = parseStrictPositiveInteger(entry.ProcessId);
    const ppid = parseStrictNonNegativeInteger(entry.ParentProcessId);
    if (pid === undefined || ppid === undefined) {
      continue;
    }

    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);

    const cpuMs = parseWindowsProcessCpuTimeMs({
      kernelModeTime: entry.KernelModeTime,
      userModeTime: entry.UserModeTime,
    });
    if (cpuMs !== null) {
      cpuByPid.set(pid, cpuMs);
    }

    const rssBytes = parseWindowsWorkingSetBytes(entry.WorkingSetSize);
    if (rssBytes !== null) {
      rssByPid.set(pid, rssBytes);
    }
  }

  return {
    childrenByParent,
    cpuByPid,
    rssByPid,
  };
}

function collectProcessTreeMetric(
  rootPid: number,
  childrenByParent: Map<number, number[]>,
  metricByPid: Map<number, number>,
): number | null {
  if (!metricByPid.has(rootPid)) {
    return null;
  }

  let total = 0;
  const seen = new Set<number>();
  const stack: number[] = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    total += metricByPid.get(pid) ?? 0;
    for (const childPid of childrenByParent.get(pid) ?? []) {
      stack.push(childPid);
    }
  }
  return total;
}

function readWindowsProcessTreeSnapshot(): ProcessTreeSnapshot | null {
  const result = spawnSync(
    resolveQaWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      [
        "$ErrorActionPreference='Stop';",
        "Get-CimInstance Win32_Process |",
        "Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize |",
        "ConvertTo-Json -Compress",
      ].join(" "),
    ],
    {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: PROCESS_TREE_SNAPSHOT_TIMEOUT_MS,
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return parseWindowsProcessTreeSnapshot(result.stdout);
}

function readProcessTreeMetric(params: {
  rootPid: number | null | undefined;
  posixColumn: "time=" | "rss=";
  parsePosixMetric: (raw: string) => number | null;
  windowsMetric: "cpuByPid" | "rssByPid";
}): number | null {
  const { rootPid } = params;
  if (typeof rootPid !== "number" || !Number.isInteger(rootPid) || rootPid <= 0) {
    return null;
  }
  if (process.platform === "win32") {
    const snapshot = readWindowsProcessTreeSnapshot();
    return snapshot
      ? collectProcessTreeMetric(rootPid, snapshot.childrenByParent, snapshot[params.windowsMetric])
      : null;
  }
  const result = spawnSync("ps", ["-eo", `pid=,ppid=,${params.posixColumn}`], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROCESS_TREE_SNAPSHOT_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    return null;
  }

  const childrenByParent = new Map<number, number[]>();
  const metricByPid = new Map<number, number>();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/u);
    if (!match) {
      continue;
    }
    const [, pidRaw, ppidRaw, metricRaw] = match;
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    const metric = params.parsePosixMetric(metricRaw ?? "");
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || metric === null) {
      continue;
    }
    metricByPid.set(pid, metric);
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }

  return collectProcessTreeMetric(rootPid, childrenByParent, metricByPid);
}

export function readProcessTreeCpuMs(rootPid: number | null | undefined): number | null {
  return readProcessTreeMetric({
    rootPid,
    posixColumn: "time=",
    parsePosixMetric: parsePsCpuTimeMs,
    windowsMetric: "cpuByPid",
  });
}

export function readProcessTreeRssBytes(rootPid: number | null | undefined): number | null {
  return readProcessTreeMetric({
    rootPid,
    posixColumn: "rss=",
    parsePosixMetric: parsePsRssBytes,
    windowsMetric: "rssByPid",
  });
}
