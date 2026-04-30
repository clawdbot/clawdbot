import { spawnSync } from "node:child_process";

export function parsePsCpuTimeMs(raw: string): number | null {
  const parts = raw.trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  if (parts.length === 2) {
    return Math.round((parts[0] * 60 + parts[1]) * 1000);
  }
  if (parts.length === 3) {
    return Math.round((parts[0] * 60 * 60 + parts[1] * 60 + parts[2]) * 1000);
  }
  return null;
}

export function parsePsRssBytes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const rssKiB = Number(trimmed);
  if (!Number.isFinite(rssKiB) || rssKiB < 0) {
    return null;
  }
  return Math.round(rssKiB * 1024);
}

export function readProcessTreeCpuMs(rootPid: number | null | undefined): number | null {
  if (
    typeof rootPid !== "number" ||
    !Number.isInteger(rootPid) ||
    rootPid <= 0 ||
    process.platform === "win32"
  ) {
    return null;
  }
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,time="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
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

  let totalCpuMs = 0;
  const seen = new Set<number>();
  const stack: number[] = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    totalCpuMs += cpuByPid.get(pid) ?? 0;
    for (const childPid of childrenByParent.get(pid) ?? []) {
      stack.push(childPid);
    }
  }
  return totalCpuMs;
}

export function readProcessTreeRssBytes(rootPid: number | null | undefined): number | null {
  if (
    typeof rootPid !== "number" ||
    !Number.isInteger(rootPid) ||
    rootPid <= 0 ||
    process.platform === "win32"
  ) {
    return null;
  }
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,rss="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
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

  let totalRssBytes = 0;
  const seen = new Set<number>();
  const stack: number[] = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    totalRssBytes += rssByPid.get(pid) ?? 0;
    for (const childPid of childrenByParent.get(pid) ?? []) {
      stack.push(childPid);
    }
  }
  return totalRssBytes;
}
