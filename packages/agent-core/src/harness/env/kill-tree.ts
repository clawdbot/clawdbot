// Agent Core module implements kill tree behavior.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const DEFAULT_GRACE_MS = 3000;
const MAX_GRACE_MS = 60_000;
const TASKKILL_COMPLETION_TIMEOUT_MS = 3000;

type ProcessSnapshot = { pid: number; startTime: string | undefined };

export type KillProcessTreeOptions = {
  graceMs?: number;
  detached?: boolean;
  force?: boolean;
};

/**
 * Best-effort process-tree termination with graceful shutdown.
 * - Windows: use taskkill /T to include descendants. Sends SIGTERM-equivalent
 *   first (without /F), then force-kills if taskkill refuses or the process
 *   survives the grace period.
 * - Unix: send SIGTERM to process group first, wait grace period, then SIGKILL.
 *
 * Group kill (`process.kill(-pid, ...)`) is only used when the PID is verified
 * as its own process group leader, unless `detached: true` is explicitly passed.
 * This prevents accidentally signaling the gateway's process group when the
 * child shares its parent's group.
 *
 * - `detached: false`: skip group kill unconditionally.
 * - `detached: true`: use group kill unconditionally (trust caller).
 * - `detached` omitted: use group kill only when PID is the group leader.
 */
export function killProcessTree(pid: number, opts?: KillProcessTreeOptions): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    if (opts?.force === true) {
      signalProcessTreeWindows(pid, "SIGKILL");
      return;
    }
    const graceMs = normalizeGraceMs(opts?.graceMs);
    killProcessTreeWindows(pid, graceMs);
    return;
  }

  const useGroupKill =
    opts?.detached === true || (opts?.detached !== false && isProcessGroupLeader(pid));
  if (opts?.force === true) {
    signalProcessTreeUnix(pid, "SIGKILL", useGroupKill);
    return;
  }

  const graceMs = normalizeGraceMs(opts?.graceMs);
  const pids = signalProcessTreeUnix(pid, "SIGTERM", useGroupKill);
  setTimeout(() => {
    let checkPids = pids;
    if (useGroupKill) {
      checkPids = [{ pid, startTime: getProcessStartTime(pid) }];
    }
    const stillAlive = useGroupKill
      ? isProcessAlive(-pid) || isProcessAlive(pid)
      : checkPids.some(
          (p) =>
            isProcessAlive(p.pid) &&
            p.startTime !== undefined &&
            getProcessStartTime(p.pid) === p.startTime,
        );
    if (!stillAlive) {
      return;
    }
    signalProcessTreeUnix(pid, "SIGKILL", useGroupKill, pids);
  }, graceMs).unref();
}

export function signalProcessTree(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  opts?: { detached?: boolean; onComplete?: () => void },
): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    opts?.onComplete?.();
    return;
  }

  if (process.platform === "win32") {
    void signalProcessTreeWindowsAndWait(pid, signal).then(opts?.onComplete);
    return;
  }

  const useGroupKill =
    opts?.detached === true || (opts?.detached !== false && isProcessGroupLeader(pid));
  signalProcessTreeUnix(pid, signal, useGroupKill);
  opts?.onComplete?.();
}

function normalizeGraceMs(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GRACE_MS;
  }
  return Math.max(0, Math.min(MAX_GRACE_MS, Math.floor(value)));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseProcessGroupId(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    return undefined;
  }
  const pgid = Number(value.trim());
  return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : undefined;
}

function readProcessGroupIdFromPs(pid: number): number | undefined {
  try {
    const res = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], {
      encoding: "utf8",
      timeout: 500,
    });
    if (res.error || res.status !== 0) {
      return undefined;
    }
    return parseProcessGroupId(res.stdout);
  } catch {
    return undefined;
  }
}

function readProcessGroupIdFromProc(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEnd = stat.lastIndexOf(")");
    if (commEnd < 0) {
      return undefined;
    }
    // After comm: state, ppid, pgrp. The command name may contain spaces or ')'.
    const fields = stat
      .slice(commEnd + 1)
      .trim()
      .split(/\s+/);
    return parseProcessGroupId(fields[2]);
  } catch {
    return undefined;
  }
}

/** Fail closed to direct-PID signaling when group ownership cannot be proved. */
function isProcessGroupLeader(pid: number): boolean {
  // Linux exposes the fact in procfs; avoid a synchronous child process on the common path.
  const procPgid = process.platform === "linux" ? readProcessGroupIdFromProc(pid) : undefined;
  const pgid = procPgid ?? readProcessGroupIdFromPs(pid);
  return pgid === pid;
}

function getProcessStartTime(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commEnd = stat.lastIndexOf(")");
      if (commEnd >= 0) {
        const fields = stat
          .slice(commEnd + 1)
          .trim()
          .split(/\s+/);
        return fields[19];
      }
    } catch {}
  }
  try {
    const res = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
    if (!res.error && res.status === 0 && res.stdout) {
      const lines = res.stdout.trim().split("\n");
      if (lines.length > 0) {
        const lstart = lines[0];
        if (lstart !== undefined && lstart.length > 0) {
          return lstart.trim();
        }
      }
    }
  } catch {}
  return undefined;
}

function getUnixProcessTreePids(rootPid: number): ProcessSnapshot[] {
  if (!Number.isFinite(rootPid) || rootPid <= 1) {
    return [];
  }

  const childrenMap = new Map<number, number[]>();

  if (process.platform === "linux") {
    try {
      const entries = readdirSync("/proc");
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) {
          continue;
        }
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
          const commEnd = stat.lastIndexOf(")");
          if (commEnd < 0) {
            continue;
          }
          const fields = stat
            .slice(commEnd + 1)
            .trim()
            .split(/\s+/);
          const ppid = Number(fields[1]);
          const pid = Number(entry);
          if (Number.isInteger(ppid) && Number.isInteger(pid) && ppid > 0 && pid > 1) {
            let list = childrenMap.get(ppid);
            if (!list) {
              list = [];
              childrenMap.set(ppid, list);
            }
            list.push(pid);
          }
        } catch {
          // Ignore process that disappeared mid-scan
        }
      }
    } catch {
      // Procfs unavailable or failed
    }
  }

  if (childrenMap.size === 0) {
    try {
      const res = spawnSync("ps", ["-ax", "-o", "pid=,ppid="], {
        encoding: "utf8",
        timeout: 1000,
      });
      if (!res.error && res.status === 0 && res.stdout) {
        const lines = res.stdout.split("\n");
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) {
            const pid = Number(parts[0]);
            const ppid = Number(parts[1]);
            if (Number.isInteger(ppid) && Number.isInteger(pid) && ppid > 0 && pid > 1) {
              let list = childrenMap.get(ppid);
              if (!list) {
                list = [];
                childrenMap.set(ppid, list);
              }
              list.push(pid);
            }
          }
        }
      }
    } catch {
      // Ignore ps failure
    }
  }

  const result: ProcessSnapshot[] = [];
  const visited = new Set<number>();

  function traverse(currentPid: number) {
    if (visited.has(currentPid)) {
      return;
    }
    visited.add(currentPid);

    const children = childrenMap.get(currentPid) ?? [];
    for (const childPid of children) {
      if (childPid > 1 && childPid !== currentPid) {
        traverse(childPid);
      }
    }
    result.push({ pid: currentPid, startTime: getProcessStartTime(currentPid) });
  }

  traverse(rootPid);
  return result;
}

function signalProcessTreeUnix(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  useGroupKill: boolean,
  pidsToSignal?: ProcessSnapshot[],
): ProcessSnapshot[] {
  if (useGroupKill) {
    try {
      process.kill(-pid, signal);
      return [];
    } catch {
      // Process group does not exist or we lack permission; try direct pid tree.
    }
  }

  pidsToSignal = pidsToSignal ?? getUnixProcessTreePids(pid);

  for (const p of pidsToSignal) {
    try {
      if (
        signal === "SIGKILL" &&
        (p.startTime === undefined || getProcessStartTime(p.pid) !== p.startTime)
      ) {
        continue;
      }
      process.kill(p.pid, signal);
    } catch {
      // Already gone.
    }
  }

  return pidsToSignal;
}

function runTaskkill(args: string[], onExit?: (code: number | null) => void): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(completionTimer);
      onExit?.(code);
      resolve();
    };
    const completionTimer = setTimeout(() => finish(null), TASKKILL_COMPLETION_TIMEOUT_MS);
    completionTimer.unref?.();
    try {
      const child = spawn("taskkill", args, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      // A failed spawn emits error before a close with a negative errno. Only
      // taskkill's first actual outcome may authorize immediate escalation.
      child.once("error", () => finish(null));
      child.once("close", (code) => finish(code));
    } catch {
      // Ignore taskkill spawn failures.
      finish(null);
    }
  });
}

function killProcessTreeWindows(pid: number, graceMs: number): void {
  let forced = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const forceKill = () => {
    if (forced) {
      return;
    }
    // Latch before probing: a later live PID could belong to a reused,
    // unrelated Windows process tree.
    forced = true;
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
    if (!isProcessAlive(pid)) {
      return;
    }
    signalProcessTreeWindows(pid, "SIGKILL");
  };

  signalProcessTreeWindows(pid, "SIGTERM", (code) => {
    if (code !== null && code !== 0) {
      forceKill();
    }
  });

  graceTimer = setTimeout(forceKill, graceMs);
  graceTimer.unref();
}

function signalProcessTreeWindows(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  onExit?: (code: number | null) => void,
): void {
  void signalProcessTreeWindowsAndWait(pid, signal, onExit);
}

function signalProcessTreeWindowsAndWait(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  onExit?: (code: number | null) => void,
): Promise<void> {
  const args =
    signal === "SIGKILL" ? ["/F", "/T", "/PID", String(pid)] : ["/T", "/PID", String(pid)];
  return runTaskkill(args, onExit);
}
