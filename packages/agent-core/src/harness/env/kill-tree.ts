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

  // A selected group remains the only target after its leader exits; its positive
  // PID may already identify an unrelated process when signaling or grace expires.
  const target =
    opts?.detached === true || (opts?.detached !== false && isProcessGroupLeader(pid)) ? -pid : pid;
  if (opts?.force === true) {
    signalUnixTarget(target, "SIGKILL");
    return;
  }

  const graceMs = normalizeGraceMs(opts?.graceMs);
  signalUnixTarget(target, "SIGTERM");
  setTimeout(() => {
    if (!isProcessAlive(target)) {
      return;
    }
    signalUnixTarget(target, "SIGKILL");
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

  const target =
    opts?.detached === true || (opts?.detached !== false && isProcessGroupLeader(pid)) ? -pid : pid;
  signalUnixTarget(target, signal);
  opts?.onComplete?.();
}

/** Signals every process group and process still owned by one forkpty session. */
export function signalPtySessionTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    void signalProcessTreeWindowsAndWait(pid, signal);
    return;
  }
  const darwinTty = process.platform === "darwin" ? readDarwinPtyTty(pid) : undefined;
  if (process.platform === "darwin" && !darwinTty) {
    signalUnixTarget(-pid, signal);
    return;
  }
  const members = readProcessSessionMembers(pid, darwinTty);
  if (!members) {
    signalUnixTarget(-pid, signal);
    return;
  }
  const signalMembers = (snapshot: Array<{ pid: number; pgid: number }>) => {
    const groups = new Set(snapshot.map((member) => member.pgid));
    groups.delete(pid);
    for (const pgid of groups) {
      signalUnixTarget(-pgid, signal);
    }
    for (const member of snapshot) {
      if (member.pid !== pid) {
        signalUnixTarget(member.pid, signal);
      }
    }
  };
  signalMembers(members);
  // Keep the leader alive through the rescan: Darwin drops the controlling-tty
  // lookup once the session leader exits.
  const remaining = readProcessSessionMembers(pid, darwinTty);
  if (remaining) {
    signalMembers(remaining);
  }
  signalUnixTarget(-pid, signal);
  signalUnixTarget(pid, signal);
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

function readDarwinPtyTty(sessionLeaderPid: number): string | undefined {
  try {
    // Darwin ps omits numeric SIDs. A forkpty session exclusively owns its
    // controlling tty, resolved here from the trusted spawn-time leader.
    const leader = spawnSync("ps", ["-p", String(sessionLeaderPid), "-o", "tty="], {
      encoding: "utf8",
      timeout: 500,
    });
    const tty = leader.stdout.trim();
    if (leader.error || leader.status !== 0 || !tty || tty === "?" || tty === "??") {
      return undefined;
    }
    return tty;
  } catch {
    return undefined;
  }
}

function readProcessSessionMembers(
  sessionId: number,
  darwinTty?: string,
): Array<{ pid: number; pgid: number }> | undefined {
  try {
    const expectedSession = darwinTty ?? String(sessionId);
    const args = darwinTty ? ["-t", darwinTty, "-o", "pid=,pgid="] : ["-axo", "pid=,pgid=,sid="];
    const result = spawnSync("ps", args, {
      encoding: "utf8",
      timeout: 500,
    });
    if (result.error || result.status !== 0) {
      return undefined;
    }
    const members: Array<{ pid: number; pgid: number }> = [];
    for (const line of result.stdout.split("\n")) {
      const [pidText, pgidText, session] = line.trim().split(/\s+/);
      const pid = parseProcessGroupId(pidText);
      const pgid = parseProcessGroupId(pgidText);
      if (pid && pgid && (darwinTty || session === expectedSession)) {
        members.push({ pid, pgid });
      }
    }
    return members;
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

function signalUnixTarget(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone or not signalable; remaining exact targets still run.
  }
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
