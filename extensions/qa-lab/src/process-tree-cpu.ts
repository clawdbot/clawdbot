// Qa Lab plugin module implements process tree cpu behavior.
import { spawnSync } from "node:child_process";
import { parseStrictFiniteNumber, parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import { resolveQaWindowsPowerShellExePath } from "./windows-system-tools.js";

type ProcessTreeSnapshot = {
  childrenByParent: Map<number, number[]>;
  cpuByPid: Map<number, number>;
  rssByPid: Map<number, number>;
};

const PROCESS_TREE_SNAPSHOT_TIMEOUT_MS = 5_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInteger(value: unknown): number | null {
  const parsed = parseStrictInteger(value);
  if (parsed === undefined || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseNonNegativeInteger(value: unknown): number | null {
  const parsed = parseStrictInteger(value);
  if (parsed === undefined || parsed < 0) {
    return null;
  }
  return parsed;
}

function parseNonNegativeNumber(value: unknown): number | null {
  const parsed = parseStrictFiniteNumber(value);
  if (parsed === undefined || parsed < 0) {
    return null;
  }
  return parsed;
}

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
  const kernelModeTime = parseNonNegativeNumber(params.kernelModeTime);
  const userModeTime = parseNonNegativeNumber(params.userModeTime);
  if (kernelModeTime === null || userModeTime === null) {
    return null;
  }
  return Math.round((kernelModeTime + userModeTime) / 10_000);
}

function parseWindowsWorkingSetBytes(raw: unknown): number | null {
  const parsed = parseNonNegativeNumber(raw);
  return parsed === null ? null : Math.round(parsed);
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
    const pid = parsePositiveInteger(entry.ProcessId);
    const ppid = parseNonNegativeInteger(entry.ParentProcessId);
    if (pid === null || ppid === null) {
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

export function readProcessTreeCpuMs(rootPid: number | null | undefined): number | null {
  if (typeof rootPid !== "number" || !Number.isInteger(rootPid) || rootPid <= 0) {
    return null;
  }
  if (process.platform === "win32") {
    const snapshot = readWindowsProcessTreeSnapshot();
    return snapshot
      ? collectProcessTreeMetric(rootPid, snapshot.childrenByParent, snapshot.cpuByPid)
      : null;
  }
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,time="], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROCESS_TREE_SNAPSHOT_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    return null;
  }

  const childrenByParent = new Map<number, number[]>();
  const cpuByPid = new Map<number, number>();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/u);
    if (!match) {
      continue;
    }
    const [, pidRaw, ppidRaw, cpuRaw] = match;
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    const cpuMs = parsePsCpuTimeMs(cpuRaw ?? "");
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || cpuMs === null) {
      continue;
    }
    cpuByPid.set(pid, cpuMs);
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  if (!cpuByPid.has(rootPid)) {
    return null;
  }

  return collectProcessTreeMetric(rootPid, childrenByParent, cpuByPid);
}

export function readProcessTreeRssBytes(rootPid: number | null | undefined): number | null {
  if (typeof rootPid !== "number" || !Number.isInteger(rootPid) || rootPid <= 0) {
    return null;
  }
  if (process.platform === "win32") {
    const snapshot = readWindowsProcessTreeSnapshot();
    return snapshot
      ? collectProcessTreeMetric(rootPid, snapshot.childrenByParent, snapshot.rssByPid)
      : null;
  }
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,rss="], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROCESS_TREE_SNAPSHOT_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    return null;
  }

  const childrenByParent = new Map<number, number[]>();
  const rssByPid = new Map<number, number>();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/u);
    if (!match) {
      continue;
    }
    const [, pidRaw, ppidRaw, rssRaw] = match;
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    const rssBytes = parsePsRssBytes(rssRaw ?? "");
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || rssBytes === null) {
      continue;
    }
    rssByPid.set(pid, rssBytes);
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  if (!rssByPid.has(rootPid)) {
    return null;
  }

  return collectProcessTreeMetric(rootPid, childrenByParent, rssByPid);
}
