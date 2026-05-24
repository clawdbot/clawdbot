import { spawn } from "node:child_process";

const DEFAULT_GRACE_MS = 3000;
const MAX_GRACE_MS = 60_000;

/**
 * Best-effort process-tree termination with graceful shutdown.
 * - Windows: use taskkill /T to include descendants. Sends SIGTERM-equivalent
 *   first (without /F), then force-kills if process survives.
 * - Unix: send SIGTERM to process group first, wait grace period, then SIGKILL.
 *
 * This gives child processes a chance to clean up (close connections, remove
 * temp files, terminate their own children) before being hard-killed.
 *
 * When the child was spawned with `detached: false` (e.g. service-managed
 * runtime under launchd/systemd), pass `detached: false` to skip the Unix
 * `process.kill(-pid, ...)` group-kill — it would otherwise target the
 * gateway's own process group and SIGTERM the gateway itself. (#71662)
 */
export function killProcessTree(
  pid: number,
  opts?: { graceMs?: number; detached?: boolean },
): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  const graceMs = normalizeGraceMs(opts?.graceMs);

  if (process.platform === "win32") {
    killProcessTreeWindows(pid, graceMs);
    return;
  }

  const useGroupKill = opts?.detached !== false;
  signalProcessTreeUnix(pid, "SIGTERM", useGroupKill);
  setTimeout(() => {
    const stillAlive = useGroupKill
      ? isProcessAlive(-pid) || isProcessAlive(pid)
      : isProcessAlive(pid);
    if (!stillAlive) {
      return;
    }
    signalProcessTreeUnix(pid, "SIGKILL", useGroupKill);
  }, graceMs).unref(); // Don't block event loop exit
}

export function signalProcessTree(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  opts?: { detached?: boolean },
): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    signalProcessTreeWindows(pid, signal);
    return;
  }

  signalProcessTreeUnix(pid, signal, opts?.detached !== false);
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

function signalProcessTreeUnix(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  useGroupKill: boolean,
): void {
  // Prefer process-group signals (`-pid`) when the child was spawned detached
  // so it has its own group; otherwise stick to the direct pid to avoid
  // signaling our own process group (the gateway). (#71662)
  if (useGroupKill) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Process group doesn't exist or we lack permission - try direct.
    }
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Already gone
  }
}

function runTaskkill(args: string[]): void {
  try {
    spawn("taskkill", args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
  } catch {
    // Ignore taskkill spawn failures
  }
}

function killProcessTreeWindows(pid: number, graceMs: number): void {
  // Step 1: Try graceful termination (taskkill without /F)
  signalProcessTreeWindows(pid, "SIGTERM");

  // Step 2: Wait grace period, then force kill only if pid still exists.
  // This avoids unconditional delayed /F kills after graceful shutdown.
  setTimeout(() => {
    if (!isProcessAlive(pid)) {
      return;
    }
    signalProcessTreeWindows(pid, "SIGKILL");
  }, graceMs).unref(); // Don't block event loop exit
}

function signalProcessTreeWindows(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  const args =
    signal === "SIGKILL" ? ["/F", "/T", "/PID", String(pid)] : ["/T", "/PID", String(pid)];
  runTaskkill(args);
}
