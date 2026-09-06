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
  if (ownedPids.size === 0 && ownedPgids.size === 0) {
    return { reaped, pending };
  }

  const bindings = loadWaitPidBindings();
  if (!bindings) {
    return { reaped, pending };
  }

  const selfPid = process.pid;
  const candidates = readDirectZombieChildren(selfPid).filter(
    (row) => ownedPids.has(row.pid) || ownedPgids.has(row.pgid) || ownedPgids.has(row.pid),
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
 * After a POSIX process-tree signal, reap owned zombies that may have been
 * reparented to this process. Root PID is always in scope; when the kill used a
 * process group, pass that PGID as well.
 */
export function reapOwnedChildZombiesAfterTreeKill(params: {
  rootPid: number;
  usedProcessGroup: boolean;
}): OwnedChildReapResult {
  const pgids = params.usedProcessGroup ? [params.rootPid] : [];
  return reapOwnedChildZombies({ pids: [params.rootPid], pgids });
}
