// Finds and cleans stale gateway process ids.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { resolveGatewayPort } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage, hasErrnoCode } from "./errors.js";
import { isGatewayArgv, parseProcCmdline } from "./gateway-process-argv.js";
import { parseStrictPositiveInteger } from "./parse-finite-number.js";
import { resolveLsofCommandSync } from "./ports-lsof.js";
import { spawnPsSync } from "./spawn-ps.js";
import { getWindowsInstallRoots } from "./windows-install-roots.js";
import {
  readWindowsListeningPidsOnPortSync,
  readWindowsListeningPidsResultSync,
  readWindowsProcessArgsResultSync,
  readWindowsProcessArgsSync,
  type WindowsProcessArgsResult,
  type WindowsListeningPidsResult,
} from "./windows-port-pids.js";

const SPAWN_TIMEOUT_MS = 2000;
const STALE_SIGTERM_WAIT_MS = 600;
const STALE_SIGKILL_WAIT_MS = 400;
/**
 * After SIGKILL, the kernel may not release the TCP port immediately.
 * Poll until the port is confirmed free (or until the budget expires) before
 * returning control to the caller (typically `triggerOpenClawRestart` →
 * `systemctl restart`). Without this wait the new process races the dying
 * process for the port and systemd enters an EADDRINUSE restart loop.
 *
 * POLL_SPAWN_TIMEOUT_MS is intentionally much shorter than SPAWN_TIMEOUT_MS
 * so that a single slow or hung lsof invocation does not consume the entire
 * polling budget. At 400 ms per call, up to five independent lsof attempts
 * fit within PORT_FREE_TIMEOUT_MS = 2000 ms, each with a definitive outcome.
 */
const PORT_FREE_POLL_INTERVAL_MS = 50;
const PORT_FREE_TIMEOUT_MS = 2000;
const POLL_SPAWN_TIMEOUT_MS = 400;

/**
 * Upper bound on the ancestor-PID walk. A real-world chain is shallow
 * (pid1 → systemd → gateway → plugin-host → sidecar ≈ 5); 32 generously covers
 * nested-supervisor setups (k8s pod → containerd-shim → runc → …) while still
 * providing a hard stop against corrupted process tables or ppid cycles.
 */
const MAX_ANCESTOR_WALK_DEPTH = 32;

const restartLog = createSubsystemLogger("restart");
const sleepSyncOverride: ((ms: number) => void) | null = null;
const dateNowOverride: (() => number) | null = null;
const parentPidOverride: (() => number) | null = null;

function getTimeMs(): number {
  return dateNowOverride ? dateNowOverride() : Date.now();
}

function sleepSync(ms: number): void {
  const timeoutMs = Math.max(0, Math.floor(ms));
  if (timeoutMs <= 0) {
    return;
  }
  if (sleepSyncOverride) {
    sleepSyncOverride(timeoutMs);
    return;
  }
  try {
    const lock = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(lock, 0, 0, timeoutMs);
  } catch {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Best-effort fallback when Atomics.wait is unavailable.
    }
  }
}

function getParentPid(): number {
  return parentPidOverride ? parentPidOverride() : process.ppid;
}

/**
 * Read a single ancestor PID from `/proc/<pid>/status` on Linux.
 * Returns null on any failure (non-Linux platform, restricted /proc, race
 * where the target pid exited between the walk step and the read); callers
 * treat a null return as "stop walking" and proceed with the ancestor set
 * collected so far.
 */
function readParentPidFromProc(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^PPid:\s*(\d+)/m);
    if (!match) {
      return null;
    }
    const parsed = Number.parseInt(match[1] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    // Null truncates the walk at this hop. In hardened Linux (hidepid=2,
    // gVisor, AppArmor-locked namespaces) /proc is unreadable beyond the
    // caller, so the walk can stop at `process.ppid`. #68451's direct
    // gateway→sidecar topology is covered (ppid is captured without a
    // /proc read); 3-level chains (gateway→plugin-host→sidecar) are not
    // — pinned by the "grandparent stays killable when /proc truncates
    // the walk" regression test.
    return null;
  }
}

function readParentPidFromPs(pid: number, spawnTimeoutMs: number): number | null {
  try {
    const res = spawnPsSync(["-o", "ppid=", "-p", String(pid)], spawnTimeoutMs);
    if (res.error || res.status !== 0 || !res.stdout.trim()) {
      return null;
    }
    return parseStrictPositiveInteger(res.stdout.trim()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Collect the set of PIDs whose termination would cascade-kill the caller:
 * the current process, its direct parent, and — where the platform permits
 * — the full ancestor chain up to the top of the pid namespace.
 *
 * Rationale: `cleanStaleGatewayProcessesSync` already refuses to kill
 * `process.pid` (see `parsePidsFromLsofOutput`), acknowledging the invariant
 * "a cleanup step must never destroy its own caller." That invariant was
 * applied only to the caller itself, not to its ancestors — which is how
 * issue #68451 arises: a plugin sidecar calls the cleanup, `lsof` reports
 * the parent gateway listening on 18789, the parent's PID passes the
 * `pid !== process.pid` filter, it is SIGTERM'd, the sidecar is then reaped
 * by the supervisor, the supervisor restarts the gateway, which re-spawns
 * the sidecar, which runs the cleanup again — infinite restart loop.
 *
 * Completing the invariant here removes the loop at its source: killing any
 * ancestor is exactly as fatal to the caller as killing itself, so ancestors
 * must receive the same exclusion treatment. The check admits any positive
 * ancestor PID (including 1), because inside a container — a first-class
 * deployment target for this project — the gateway is frequently the
 * entrypoint and therefore runs as PID 1 of its own namespace; excluding 1
 * unconditionally would recreate the #68451 loop on every containerised
 * install where the gateway spawns a direct-child sidecar.
 *
 * The walk is best-effort. `process.ppid` is provided by Node via a direct
 * syscall and is always available; transitive ancestors are read on Linux via
 * `/proc` and on macOS via `ps`. Windows stops at ppid.
 *
 * The function exposes no runtime hooks. Tests exercise the real walk by
 * stubbing `process.ppid` (and, on Linux, by mocking `node:fs` to inject
 * `/proc/<pid>/status` payloads) — there is no reachable override for
 * runtime callers to mutate.
 */
export function getSelfAndAncestorPidsSync(spawnTimeoutMs = SPAWN_TIMEOUT_MS): Set<number> {
  const pids = new Set<number>([process.pid]);
  const immediateParent = getParentPid();
  if (!Number.isFinite(immediateParent) || immediateParent <= 0) {
    return pids;
  }
  pids.add(immediateParent);
  const readTransitiveParent =
    process.platform === "linux"
      ? readParentPidFromProc
      : process.platform === "darwin"
        ? (pid: number) => readParentPidFromPs(pid, spawnTimeoutMs)
        : null;
  if (!readTransitiveParent) {
    return pids;
  }
  // Transitive ancestor walk. Each hop's validity (positive pid, not already
  // seen) is enforced by the per-iteration `parent` check below; the entry
  // invariant `current > 0` is established above and preserved by `current =
  // parent` after the same check, so no separate top-of-loop guard is needed.
  let current = immediateParent;
  for (let depth = 0; depth < MAX_ANCESTOR_WALK_DEPTH; depth++) {
    const parent = readTransitiveParent(current);
    if (parent == null || parent <= 0 || pids.has(parent)) {
      break;
    }
    pids.add(parent);
    current = parent;
  }
  return pids;
}

function getExcludedGatewayPidsSync(spawnTimeoutMs: number, protectedPid?: number): Set<number> {
  const excluded = getSelfAndAncestorPidsSync(spawnTimeoutMs);
  if (typeof protectedPid === "number" && Number.isSafeInteger(protectedPid) && protectedPid > 0) {
    // A reparented service can become a sibling and disappear from the ancestor walk.
    excluded.add(protectedPid);
  }
  return excluded;
}

/**
 * Parse raw PIDs from lsof -Fpc stdout, excluding the current
 * process and its ancestors (see `getSelfAndAncestorPidsSync` for the full
 * rationale). On Linux the ancestor lookup reads up to
 * `MAX_ANCESTOR_WALK_DEPTH` entries from `/proc/<pid>/status`; each read is
 * a virtual-filesystem access (no disk I/O, no external process), wrapped
 * in try/catch and degrades silently. On macOS the lookup shells out to `ps`
 * with the caller's spawn timeout. Windows only uses the in-memory direct
 * parent from `process.ppid`.
 */
function parseLsofEntries(stdout: string): Array<{ pid: number; cmd?: string }> {
  const entries: Array<{ pid: number; cmd?: string }> = [];
  let currentPid: number | undefined;
  let currentCmd: string | undefined;
  const flush = () => {
    if (currentPid != null) {
      entries.push({ pid: currentPid, ...(currentCmd ? { cmd: currentCmd } : {}) });
    }
  };
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith("p")) {
      flush();
      const parsed = parseStrictPositiveInteger(line.slice(1));
      currentPid = parsed ?? undefined;
      currentCmd = undefined;
    } else if (line.startsWith("c")) {
      currentCmd = line.slice(1);
    }
  }
  flush();
  return entries;
}

function parsePsCommandLine(raw: string): string[] {
  const args: string[] = [];
  for (const match of raw.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) {
      args.push(value);
    }
  }
  return args;
}

function readUnixProcessArgsSync(pid: number, spawnTimeoutMs: number): string[] | null {
  if (process.platform === "linux") {
    try {
      const args = parseProcCmdline(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
      if (args.length > 0) {
        return args;
      }
    } catch {
      // Fall back to ps below; /proc may be unavailable or restricted.
    }
  }
  const res = spawnPsSync(["-ww", "-p", String(pid), "-o", "command="], spawnTimeoutMs);
  if (res.error || res.status !== 0 || !res.stdout.trim()) {
    return null;
  }
  return parsePsCommandLine(res.stdout.trim());
}

function verifyGatewayPidByArgvSync(pid: number, spawnTimeoutMs: number): boolean {
  const args = readUnixProcessArgsSync(pid, spawnTimeoutMs);
  return args != null && isGatewayArgv(args, { allowGatewayBinary: true });
}

function parsePidsFromLsofOutput(
  stdout: string,
  spawnTimeoutMs: number,
  protectedPid?: number,
): number[] {
  // Deduplicate: dual-stack listeners (IPv4 + IPv6) cause lsof to emit the
  // same PID twice. Return each PID at most once to avoid double-killing.
  // Exclude self and ancestors — terminating any ancestor cascade-kills the
  // caller via the supervisor, recreating the #68451 restart loop.
  const excluded = getExcludedGatewayPidsSync(spawnTimeoutMs, protectedPid);
  const pids: number[] = [];
  for (const entry of parseLsofEntries(stdout)) {
    if (excluded.has(entry.pid)) {
      continue;
    }
    if (entry.cmd && normalizeLowercaseStringOrEmpty(entry.cmd).includes("openclaw")) {
      pids.push(entry.pid);
      continue;
    }
    if (verifyGatewayPidByArgvSync(entry.pid, spawnTimeoutMs)) {
      pids.push(entry.pid);
    }
  }
  return uniqueValues(pids);
}

/**
 * Windows: find listening PIDs on the port, then verify each is an openclaw
 * gateway process via command-line inspection. Excludes the current process
 * and its ancestors (same invariant as the lsof path — see
 * `getSelfAndAncestorPidsSync`).
 */
function filterVerifiedWindowsGatewayPids(rawPids: number[], protectedPid?: number): number[] {
  const excluded = getExcludedGatewayPidsSync(SPAWN_TIMEOUT_MS, protectedPid);
  return uniqueValues(rawPids)
    .filter((pid) => Number.isFinite(pid) && pid > 0 && !excluded.has(pid))
    .filter((pid) => {
      const args = readWindowsProcessArgsSync(pid);
      return args != null && isGatewayArgv(args, { allowGatewayBinary: true });
    });
}

function filterVerifiedWindowsGatewayPidsResult(
  rawPids: number[],
  processArgsResult: (pid: number) => WindowsProcessArgsResult,
  protectedPid?: number,
): WindowsListeningPidsResult {
  const excluded = getExcludedGatewayPidsSync(SPAWN_TIMEOUT_MS, protectedPid);
  const verified: number[] = [];
  for (const pid of uniqueValues(rawPids)) {
    if (!Number.isFinite(pid) || pid <= 0 || excluded.has(pid)) {
      continue;
    }
    const argsResult = processArgsResult(pid);
    if (!argsResult.ok) {
      return { ok: false, permanent: argsResult.permanent };
    }
    if (argsResult.args != null && isGatewayArgv(argsResult.args, { allowGatewayBinary: true })) {
      verified.push(pid);
    }
  }
  return { ok: true, pids: verified };
}

function findVerifiedWindowsGatewayPidsOnPortSync(port: number, protectedPid?: number): number[] {
  return filterVerifiedWindowsGatewayPids(readWindowsListeningPidsOnPortSync(port), protectedPid);
}

function findVerifiedWindowsGatewayPidsOnPortResultSync(
  port: number,
  protectedPid?: number,
): WindowsListeningPidsResult {
  const result = readWindowsListeningPidsResultSync(port);
  if (!result.ok) {
    return result;
  }
  return filterVerifiedWindowsGatewayPidsResult(
    result.pids,
    (pid) => readWindowsProcessArgsResultSync(pid),
    protectedPid,
  );
}

function findGatewayPidsOnPortWithProtectedPidSync(
  port: number,
  spawnTimeoutMs: number,
  protectedPid?: number,
): number[] {
  if (process.platform === "win32") {
    // Use the shared Windows port inspection (PowerShell / netstat) with
    // command-line verification to find only openclaw gateway processes.
    return findVerifiedWindowsGatewayPidsOnPortSync(port, protectedPid);
  }
  const lsof = resolveLsofCommandSync();
  const res = spawnSync(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
    encoding: "utf8",
    timeout: spawnTimeoutMs,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    // Missing lsof is an expected state on minimal hosts. Permission and timeout
    // failures still need the diagnostic below because the binary was not simply absent.
    if (code === "ENOENT") {
      return [];
    }
    const detail =
      code && code.trim().length > 0
        ? code
        : res.error instanceof Error
          ? res.error.message
          : "unknown error";
    restartLog.warn(`lsof failed during initial stale-pid scan for port ${port}: ${detail}`);
    return [];
  }
  if (res.status === 1) {
    return [];
  }
  if (res.status !== 0) {
    restartLog.warn(
      `lsof exited with status ${res.status} during initial stale-pid scan for port ${port}; skipping stale pid check`,
    );
    return [];
  }
  return parsePidsFromLsofOutput(res.stdout, spawnTimeoutMs, protectedPid);
}

/**
 * Find PIDs of gateway processes listening on the given port using synchronous lsof.
 * Returns only PIDs that belong to openclaw gateway processes (not the current process).
 */
export function findGatewayPidsOnPortSync(
  port: number,
  spawnTimeoutMs = SPAWN_TIMEOUT_MS,
): number[] {
  return findGatewayPidsOnPortWithProtectedPidSync(port, spawnTimeoutMs);
}

/**
 * Attempt a single lsof poll for the given port.
 *
 * Returns a discriminated union with four possible states:
 *
 *   { free: true }                      — port confirmed free
 *   { free: false }                     — port confirmed busy
 *   { free: null; permanent: false }    — transient error, keep retrying
 *   { free: null; permanent: true }     — lsof unavailable (ENOENT / EACCES),
 *                                         no point retrying
 *
 * Separating transient from permanent errors is critical so that:
 *  1. A slow/timed-out lsof call (transient) does not abort the polling loop —
 *     the caller retries until the wall-clock budget expires.
 *  2. Non-zero lsof exits from runtime/permission failures (status > 1) are
 *     not misclassified as "port free" — they are inconclusive and retried.
 *  3. A missing lsof binary (permanent) short-circuits cleanly rather than
 *     spinning the full budget pointlessly.
 */
type PollResult = { free: true } | { free: false } | { free: null; permanent: boolean };

function pollPortOnce(port: number): PollResult {
  if (process.platform === "win32") {
    return pollPortOnceWindows(port);
  }
  try {
    const lsof = resolveLsofCommandSync();
    const res = spawnSync(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
      encoding: "utf8",
      timeout: POLL_SPAWN_TIMEOUT_MS,
    });
    if (res.error) {
      // Spawn-level failure. ENOENT / EACCES means lsof is permanently
      // unavailable on this system; other errors (e.g. timeout) are transient.
      const code = (res.error as NodeJS.ErrnoException).code;
      const permanent = code === "ENOENT" || code === "EACCES" || code === "EPERM";
      return { free: null, permanent };
    }
    if (res.status === 1) {
      // lsof canonical "no matching processes" exit — port is genuinely free.
      // Guard: on Linux containers with restricted /proc (AppArmor, seccomp,
      // user namespaces), lsof can exit 1 AND still emit partial output. Any
      // record is enough to keep the poll fail-closed, even if its PID is malformed.
      return res.stdout.trim() ? { free: false } : { free: true };
    }
    if (res.status !== 0) {
      // status > 1: runtime/permission/flag error. Cannot confirm port state —
      // treat as a transient failure and keep polling rather than falsely
      // reporting the port as free (which would recreate the EADDRINUSE race).
      return { free: null, permanent: false };
    }
    // status === 0: lsof found a listener. Occupancy does not depend on whether
    // its PID field is present, valid, or attributable to an OpenClaw process.
    return { free: false };
  } catch {
    return { free: null, permanent: false };
  }
}

/**
 * Windows-specific port poll.
 * Uses a short timeout (POLL_SPAWN_TIMEOUT_MS) so a single slow PowerShell
 * invocation cannot exceed the waitForPortFreeSync wall-clock budget.
 * Only checks whether any process is listening — no gateway verification
 * needed because we already killed the stale gateway in the prior step.
 */
function pollPortOnceWindows(port: number): PollResult {
  try {
    const result = readWindowsListeningPidsResultSync(port, POLL_SPAWN_TIMEOUT_MS);
    if (!result.ok) {
      return { free: null, permanent: result.permanent };
    }
    return result.pids.length === 0 ? { free: true } : { free: false };
  } catch {
    return { free: null, permanent: false };
  }
}

/**
 * Synchronously terminate stale gateway processes.
 * Callers must pass a non-empty pids array.
 *
 * On Unix: sends SIGTERM, waits briefly, then SIGKILL for survivors.
 * On Windows: uses taskkill (graceful first, then /F for force-kill).
 */
function terminateStaleProcessesSync(pids: number[]): number[] {
  if (process.platform === "win32") {
    return terminateStaleProcessesWindows(pids);
  }
  const killed: number[] = [];
  for (const pid of pids) {
    if (trySignalStaleProcess(pid, "SIGTERM")) {
      killed.push(pid);
    }
  }
  if (killed.length === 0) {
    return killed;
  }
  sleepSync(STALE_SIGTERM_WAIT_MS);
  for (const pid of killed) {
    if (isProcessAlive(pid)) {
      trySignalStaleProcess(pid, "SIGKILL");
    }
  }
  sleepSync(STALE_SIGKILL_WAIT_MS);
  return killed;
}

function trySignalStaleProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (!hasErrnoCode(error, "ESRCH")) {
      restartLog.warn(
        `failed to send ${signal} to stale gateway process ${pid}: ${formatErrorMessage(error)}`,
      );
    }
    return false;
  }
}

/**
 * Windows-specific process termination using taskkill.
 * Sends a graceful taskkill first (/T for tree), waits, then escalates to /F.
 */
function terminateStaleProcessesWindows(pids: number[]): number[] {
  const taskkillPath = path.win32.join(
    getWindowsInstallRoots().systemRoot,
    "System32",
    "taskkill.exe",
  );
  const killed: number[] = [];
  for (const pid of pids) {
    const graceful = spawnSync(taskkillPath, ["/T", "/PID", String(pid)], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
    const gracefulFailed = graceful.error != null || (graceful.status ?? 0) !== 0;
    if (!gracefulFailed && !isProcessAlive(pid)) {
      killed.push(pid);
      continue;
    }
    sleepSync(STALE_SIGTERM_WAIT_MS);
    if (!isProcessAlive(pid)) {
      killed.push(pid);
      continue;
    }
    const forced = spawnSync(taskkillPath, ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
    if (forced.error != null || (forced.status ?? 0) !== 0) {
      continue;
    }
    sleepSync(STALE_SIGKILL_WAIT_MS);
    if (!isProcessAlive(pid)) {
      killed.push(pid);
    }
  }
  return killed;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Poll the given port until it is confirmed free, lsof is confirmed unavailable,
 * or the wall-clock budget expires.
 *
 * Each poll invocation uses POLL_SPAWN_TIMEOUT_MS (400 ms), which is
 * significantly shorter than PORT_FREE_TIMEOUT_MS (2000 ms). This ensures
 * that a single slow or hung lsof call cannot consume the entire polling
 * budget and cause the function to exit prematurely with an inconclusive
 * result. Up to five independent lsof attempts fit within the budget.
 *
 * Exit conditions:
 *   - `pollPortOnce` returns `{ free: true }`                    → port confirmed free
 *   - `pollPortOnce` returns `{ free: null, permanent: true }`   → lsof unavailable, bail
 *   - `pollPortOnce` returns `{ free: false }`                   → port busy, sleep + retry
 *   - `pollPortOnce` returns `{ free: null, permanent: false }`  → transient error, sleep + retry
 *   - Wall-clock deadline exceeded                               → log warning, proceed anyway
 */
function waitForPortFreeSync(port: number): void {
  const deadline = getTimeMs() + PORT_FREE_TIMEOUT_MS;
  while (getTimeMs() < deadline) {
    const result = pollPortOnce(port);
    if (result.free === true) {
      return;
    }
    if (result.free === null && result.permanent) {
      // lsof is permanently unavailable (ENOENT / EACCES) — bail immediately,
      // no point spinning the remaining budget.
      return;
    }
    // result.free === false: port still bound.
    // result.free === null && !permanent: transient lsof error — keep polling.
    sleepSync(PORT_FREE_POLL_INTERVAL_MS);
  }
  restartLog.warn(`port ${port} still in use after ${PORT_FREE_TIMEOUT_MS}ms; proceeding anyway`);
}

/**
 * Inspect the gateway port and kill any stale gateway processes holding it.
 * Blocks until the port is confirmed free (or the poll budget expires) so
 * the supervisor (systemd / launchctl) does not race a zombie process for
 * the port and enter an EADDRINUSE restart loop.
 *
 * Called before service restart commands to prevent port conflicts.
 */
type CleanStaleGatewayProcessesOptions = {
  protectedPid?: number;
};

export function cleanStaleGatewayProcessesSync(
  portOverride?: number,
  options?: CleanStaleGatewayProcessesOptions,
): number[] {
  try {
    const port =
      typeof portOverride === "number" && Number.isFinite(portOverride) && portOverride > 0
        ? Math.floor(portOverride)
        : resolveGatewayPort(undefined, process.env);
    const protectedPid = options?.protectedPid;
    const stalePids =
      process.platform === "win32"
        ? (() => {
            const result = findVerifiedWindowsGatewayPidsOnPortResultSync(port, protectedPid);
            if (result.ok) {
              return result.pids;
            }
            waitForPortFreeSync(port);
            return [];
          })()
        : findGatewayPidsOnPortWithProtectedPidSync(port, SPAWN_TIMEOUT_MS, protectedPid);
    if (stalePids.length === 0) {
      return [];
    }
    restartLog.warn(
      `killing ${stalePids.length} stale gateway process(es) before restart: ${stalePids.join(", ")}`,
    );
    const killed = terminateStaleProcessesSync(stalePids);
    // Wait for the port to be released before returning — called unconditionally
    // even when `killed` is empty (all pids were already dead before SIGTERM).
    // A process can exit before our signal arrives yet still leave its socket
    // in TIME_WAIT / FIN_WAIT; polling is the only reliable way to confirm the
    // kernel has fully released the port before systemd fires the new process.
    waitForPortFreeSync(port);
    return killed;
  } catch {
    return [];
  }
}
