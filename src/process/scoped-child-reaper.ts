/**
 * Scoped reaper for unreaped direct children owned by a spawner.
 *
 * After process-tree kills, grandchildren that already exited can be reparented
 * to this process as zombies without a Node ChildProcess handle. libuv only
 * waitpids tracked PIDs, so those zombies linger until restart (#97616).
 *
 * This module reaps only PIDs that match an explicit owner scope (root PID and/or
 * process group). It never calls waitpid(-1) and never sends SIGCHLD to self —
 * that rejected design lived in #97731.
 *
 * Linux uses the same libc/koffi loading pattern as spawn-secret-input.
 * Other platforms are no-ops (Windows Job Objects already own tree lifetime).
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

export type OwnedChildReapScope = {
  /** Direct-child PIDs this spawner created or adopted into its kill scope. */
  pids?: readonly number[];
  /** Process groups this spawner signaled (typically the detached root PGID). */
  pgids?: readonly number[];
  /**
   * Node-tracked ChildProcess PIDs. Never waitpid these — libuv owns their
   * exit status; stealing it yields ECHILD and skipped completion handlers.
   */
  excludeTrackedPids?: readonly number[];
};

export type OwnedChildReapResult = {
  /** PIDs successfully waited in this call. */
  reaped: number[];
  /** Matching zombies that were still present but waitpid returned 0 (WNOHANG). */
  pending: number[];
};

type ProcZombie = {
  pid: number;
  ppid: number;
  pgid: number;
};

type WaitPidBindings = {
  waitpid: (pid: number, status: number[], options: number) => number;
  errno: () => number;
};

const WNOHANG = 1;
const require = createRequire(import.meta.url);

let waitPidBindings: WaitPidBindings | null | undefined;

function loadWaitPidBindings(): WaitPidBindings | null {
  if (waitPidBindings !== undefined) {
    return waitPidBindings;
  }
  if (process.platform === "win32") {
    waitPidBindings = null;
    return waitPidBindings;
  }
  try {
    // SAFETY: Koffi's require export has the same API as its typed default export.
    const koffi = require("koffi") as typeof import("koffi").default;
    const libc = koffi.load(null);
    const waitpid = libc.func("int waitpid(int pid, _Out_ int *status, int options)");
    waitPidBindings = {
      waitpid: (pid, status, options) => waitpid(pid, status, options) as number,
      errno: () => koffi.errno(),
    };
  } catch {
    waitPidBindings = null;
  }
  return waitPidBindings;
}

/** Test-only override for waitpid bindings (avoids loading koffi in unit mocks). */
export function setOwnedChildWaitPidBindingsForTests(
  bindings: WaitPidBindings | null | undefined,
): void {
  waitPidBindings = bindings;
}

function parseLinuxStat(stat: string): ProcZombie | undefined {
  const rparen = stat.lastIndexOf(")");
  if (rparen < 0) {
    return undefined;
  }
  const pid = Number.parseInt(stat.slice(0, stat.indexOf(" ")), 10);
  const rest = stat.slice(rparen + 2).split(" ");
  const state = rest[0];
  const ppid = Number.parseInt(rest[1] ?? "", 10);
  const pgid = Number.parseInt(rest[2] ?? "", 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (!state?.startsWith("Z")) {
    return undefined;
  }
  if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)) {
    return undefined;
  }
  return { pid, ppid, pgid };
}

function readDirectZombieChildren(selfPid: number): ProcZombie[] {
  if (process.platform !== "linux") {
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const zombies: ProcZombie[] = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue;
    }
    const parsed = parseLinuxStat(stat);
    if (parsed && parsed.ppid === selfPid) {
      zombies.push(parsed);
    }
  }
  return zombies;
}

function normalizeIdSet(values: readonly number[] | undefined): Set<number> {
  const out = new Set<number>();
  for (const value of values ?? []) {
    if (Number.isSafeInteger(value) && value > 0) {
      out.add(value);
    }
  }
  return out;
}

/**
 * Reap zombie direct children that match the caller's owned PID/PGID scope.
 * Safe to call repeatedly; never waits on unscoped children.
 */
export function reapOwnedChildZombies(scope: OwnedChildReapScope): OwnedChildReapResult {
  const reaped: number[] = [];
  const pending: number[] = [];
  if (process.platform === "win32") {
    return { reaped, pending };
  }
  const ownedPids = normalizeIdSet(scope.pids);
  const ownedPgids = normalizeIdSet(scope.pgids);
  const excludedTracked = normalizeIdSet(scope.excludeTrackedPids);
  if (ownedPids.size === 0 && ownedPgids.size === 0) {
    return { reaped, pending };
  }

  const bindings = loadWaitPidBindings();
  if (!bindings) {
    return { reaped, pending };
  }

  const selfPid = process.pid;
  const candidates = readDirectZombieChildren(selfPid).filter(
    (row) =>
      !excludedTracked.has(row.pid) &&
      (ownedPids.has(row.pid) || ownedPgids.has(row.pgid) || ownedPgids.has(row.pid)),
  );

  const status = [0];
  for (const row of candidates) {
    // Only the parent may wait. Scope filter above is the only authority for
    // which zombies belong to this spawner — never waitpid(-1).
    const waited = bindings.waitpid(row.pid, status, WNOHANG);
    if (waited === row.pid) {
      reaped.push(row.pid);
      continue;
    }
    if (waited === 0) {
      pending.push(row.pid);
      continue;
    }
    // ECHILD: already reaped by another owner path; treat as gone.
    if (bindings.errno() === 10 /* ECHILD */) {
      reaped.push(row.pid);
    }
  }
  return { reaped, pending };
}

/**
 * After a POSIX process-tree kill + Node-tracked root exit, reap adopted
 * zombies that match the root's process group. Never waitpids the Node-tracked
 * root — libuv owns that ChildProcess. Without a process-group kill, this is a
 * no-op (cannot safely identify adopted children without waiting the root).
 */
export function reapOwnedChildZombiesAfterTreeKill(params: {
  rootPid: number;
  usedProcessGroup: boolean;
  /** Defaults to [rootPid]. Extra Node-tracked PIDs may be listed. */
  excludeTrackedPids?: readonly number[];
}): OwnedChildReapResult {
  if (!params.usedProcessGroup) {
    return { reaped: [], pending: [] };
  }
  const excludeTrackedPids = params.excludeTrackedPids ?? [params.rootPid];
  return reapOwnedChildZombies({
    pgids: [params.rootPid],
    excludeTrackedPids,
  });
}

type ProcRow = {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
};

function parseLinuxProcRow(stat: string): ProcRow | undefined {
  const rparen = stat.lastIndexOf(")");
  if (rparen < 0) {
    return undefined;
  }
  const pid = Number.parseInt(stat.slice(0, stat.indexOf(" ")), 10);
  const rest = stat.slice(rparen + 2).split(" ");
  const state = rest[0] ?? "";
  const ppid = Number.parseInt(rest[1] ?? "", 10);
  const pgid = Number.parseInt(rest[2] ?? "", 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)) {
    return undefined;
  }
  return { pid, ppid, pgid, state };
}

/** Live or zombie processes still carrying the owned process group. */
function readOwnedPgidMembers(pgid: number, excludeTracked: Set<number>): ProcRow[] {
  if (process.platform !== "linux" || pgid <= 0) {
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const rows: ProcRow[] = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue;
    }
    const row = parseLinuxProcRow(stat);
    if (!row || row.pgid !== pgid || excludeTracked.has(row.pid)) {
      continue;
    }
    rows.push(row);
  }
  return rows;
}

export type RetainAdoptedCleanupHandle = {
  /** Stop retaining cleanup early (tests / dispose). */
  stop: () => void;
};

export type RetainAdoptedCleanupOptions = {
  rootPid: number;
  excludeTrackedPids?: readonly number[];
  /** Safety ceiling so a stuck live pgid member cannot retain forever. */
  maxRetainMs?: number;
  /** Test seam: override scheduler (defaults to setImmediate / setTimeout(0)). */
  schedule?: (callback: () => void) => void;
  /** Test seam: clock for the safety ceiling. */
  now?: () => number;
};

/**
 * Keep scoped cleanup alive until the owned process group has drained and a
 * quiet scan finds no adopted zombies. Covers delayed adoption where an
 * intermediate still holds an exited grandchild at the root's first exit scan.
 * Does not use waitpid(-1) or SIGCHLD.
 */
export function retainAdoptedChildZombieCleanup(
  options: RetainAdoptedCleanupOptions,
): RetainAdoptedCleanupHandle {
  const rootPid = options.rootPid;
  const excludeTrackedPids = options.excludeTrackedPids ?? [rootPid];
  const excludeSet = normalizeIdSet(excludeTrackedPids);
  const maxRetainMs = options.maxRetainMs ?? 30_000;
  const now = options.now ?? Date.now;
  const schedule =
    options.schedule ??
    ((callback: () => void) => {
      // Yield to the event loop while live pgid members remain; retention is
      // still lifecycle-driven by pgid drain (not a fixed "hope it adopted" delay).
      setTimeout(callback, 0);
    });
  const startedAt = now();
  let stopped = false;
  let quietScans = 0;
  let scheduled = false;

  const stop = () => {
    stopped = true;
  };

  const tick = () => {
    scheduled = false;
    if (stopped || process.platform === "win32") {
      return;
    }
    reapOwnedChildZombiesAfterTreeKill({
      rootPid,
      usedProcessGroup: true,
      excludeTrackedPids,
    });
    const members = readOwnedPgidMembers(rootPid, excludeSet);
    const liveOrZombieRemain = members.length > 0;
    if (!liveOrZombieRemain) {
      quietScans += 1;
    } else {
      quietScans = 0;
    }
    if (quietScans >= 2) {
      stop();
      return;
    }
    if (now() - startedAt >= maxRetainMs) {
      stop();
      return;
    }
    if (!scheduled) {
      scheduled = true;
      schedule(tick);
    }
  };

  schedule(tick);
  return { stop };
}

/**
 * Schedule retained adopted-zombie cleanup after the Node-tracked child exits
 * so libuv can consume the root's status first. Safe to call at signal time.
 */
export function scheduleAdoptedChildZombieReapAfterExit(
  child: {
    pid?: number | undefined;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    once: (event: "exit", listener: () => void) => unknown;
  },
  usedProcessGroup: boolean,
): RetainAdoptedCleanupHandle | undefined {
  const rootPid = child.pid;
  if (typeof rootPid !== "number" || rootPid <= 0 || !usedProcessGroup) {
    return undefined;
  }
  const start = () =>
    retainAdoptedChildZombieCleanup({
      rootPid,
      excludeTrackedPids: [rootPid],
    });
  if (child.exitCode !== null || child.signalCode !== null) {
    let handle: RetainAdoptedCleanupHandle | undefined;
    setImmediate(() => {
      handle = start();
    });
    return {
      stop: () => handle?.stop(),
    };
  }
  let handle: RetainAdoptedCleanupHandle | undefined;
  child.once("exit", () => {
    setImmediate(() => {
      handle = start();
    });
  });
  return {
    stop: () => handle?.stop(),
  };
}
