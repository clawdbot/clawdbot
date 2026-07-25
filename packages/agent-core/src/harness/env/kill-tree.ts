// Agent Core module implements kill tree behavior.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DEFAULT_GRACE_MS = 3000;
const MAX_GRACE_MS = 60_000;
const TASKKILL_COMPLETION_TIMEOUT_MS = 3000;

export type KillProcessTreeOptions = {
  graceMs?: number;
  detached?: boolean;
  force?: boolean;
};

/**
 * Best-effort process-tree termination with graceful shutdown.
 * - Windows: use taskkill /T to include descendants. Sends SIGTERM-equivalent
 *   first (without /F), then force-kills if process survives.
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
  signalProcessTreeUnix(pid, "SIGTERM", useGroupKill);
  setTimeout(() => {
    const stillAlive = useGroupKill
      ? isProcessAlive(-pid) || isProcessAlive(pid)
      : isProcessAlive(pid);
    if (!stillAlive) {
      return;
    }
    signalProcessTreeUnix(pid, "SIGKILL", useGroupKill);
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

function signalProcessTreeUnix(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  useGroupKill: boolean,
): void {
  if (useGroupKill) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Process group does not exist or we lack permission; try direct pid.
    }
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

function runTaskkill(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(completionTimer);
      resolve();
    };
    const completionTimer = setTimeout(finish, TASKKILL_COMPLETION_TIMEOUT_MS);
    completionTimer.unref?.();
    try {
      const child = spawn("taskkill", args, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      child.once("error", finish);
      child.once("close", finish);
    } catch {
      // Ignore taskkill spawn failures.
      finish();
    }
  });
}

function killProcessTreeWindows(pid: number, graceMs: number): void {
  signalProcessTreeWindows(pid, "SIGTERM");

  setTimeout(() => {
    if (!isProcessAlive(pid)) {
      return;
    }
    signalProcessTreeWindows(pid, "SIGKILL");
  }, graceMs).unref();
}

function signalProcessTreeWindows(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  void signalProcessTreeWindowsAndWait(pid, signal);
}

function signalProcessTreeWindowsAndWait(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  const args =
    signal === "SIGKILL" ? ["/F", "/T", "/PID", String(pid)] : ["/T", "/PID", String(pid)];
  return runTaskkill(args);
}
