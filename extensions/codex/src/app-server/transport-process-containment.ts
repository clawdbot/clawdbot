import { execFile } from "node:child_process";

type ContainableTransport = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
  kill?: (signal?: NodeJS.Signals) => unknown;
};

type PosixProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  startedAt: string;
};

export type CodexAppServerProcessIdentity = Pick<PosixProcess, "pid" | "pgid" | "startedAt">;

const PROCESS_COLUMNS = "pid=,ppid=,pgid=,stat=,lstart=";
const MAX_CONTAINED_PROCESSES = 512;
const MAX_PROCESS_CONTAINMENT_MS = 2_000;
const MAX_PROCESS_QUIESCE_PASSES = 16;
const PROCESS_INSPECTION_MAX_BYTES = 8 * 1024 * 1024;

export async function terminateCodexAppServerDescendants(
  child: ContainableTransport,
): Promise<(() => void) | undefined> {
  return (await containDescendants(child))?.resume;
}

/** A durable spawn fact, never a command-line match, selects the orphan root. */
export async function terminateCodexAppServerOrphan(
  expected: CodexAppServerProcessIdentity,
): Promise<boolean> {
  const deadline = Date.now() + MAX_PROCESS_CONTAINMENT_MS;
  const contained = await containDescendants(
    { pid: expected.pid, kill: (signal) => signalProcess(expected.pid, signal ?? "SIGTERM") },
    expected,
    deadline,
  );
  let gone = false;
  try {
    if (contained) {
      const current = await readProcess(expected.pid, deadline);
      if (current && isSameLiveRoot(current, contained.root, true)) {
        // Keep the verified leader stopped until its whole group is killed;
        // a QA-owned child may share its parent's group and must use its PID.
        signalProcess(current.pgid === current.pid ? -current.pid : current.pid, "SIGKILL");
      }
    }
    while (Date.now() < deadline) {
      const snapshot = await readCodexAppServerProcessSnapshot(deadline);
      if (!snapshot?.some((row) => row.pid === process.pid)) {
        return false;
      }
      const current = snapshot.find((row) => row.pid === expected.pid);
      if (!current || !hasSameIdentity(current, expected) || current.state.startsWith("Z")) {
        gone = true;
        return true;
      }
      if (!contained) {
        return false;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    return false;
  } finally {
    if (contained && !gone) {
      await signalSameRoot(contained.root, "SIGCONT", Date.now() + MAX_PROCESS_CONTAINMENT_MS);
    }
  }
}

async function containDescendants(
  child: ContainableTransport,
  expected?: CodexAppServerProcessIdentity,
  deadline = Date.now() + MAX_PROCESS_CONTAINMENT_MS,
): Promise<{ root: PosixProcess; resume: () => void } | undefined> {
  const rootPid = child.pid;
  if (process.platform === "win32" || !rootPid || !child.kill || hasExited(child)) {
    return undefined;
  }
  const snapshot = await readCodexAppServerProcessSnapshot(deadline);
  if (!snapshot || Date.now() >= deadline) {
    return undefined;
  }
  const root = snapshot.find((row) => row.pid === rootPid);
  if (
    !root ||
    !(expected ? isSameLiveProcess(root, expected) : root.ppid === process.pid) ||
    root.state.startsWith("Z")
  ) {
    return undefined;
  }

  const initialDescendants = collectDescendants(snapshot, [rootPid]);
  if (initialDescendants.length > MAX_CONTAINED_PROCESSES) {
    return undefined;
  }
  const stoppedDescendants = new Map<string, PosixProcess>();
  if (!(await signalSameRoot(root, "SIGSTOP", deadline))) {
    return undefined;
  }
  let resumeRootOnUnwind = true;
  try {
    const descendants = await quiesceDescendants(
      root,
      initialDescendants,
      stoppedDescendants,
      deadline,
    );
    if (!descendants) {
      return undefined;
    }

    // Parents are last: every destructive signal revalidates the exact live PID
    // while the stopped ancestry still prevents new descendants.
    for (const descendant of descendants.toReversed()) {
      if (Date.now() >= deadline) {
        return undefined;
      }
      if (!descendant.state.startsWith("Z")) {
        if (!(await signalSameProcess(descendant, "SIGKILL", deadline)) || Date.now() >= deadline) {
          return undefined;
        }
      }
    }
    resumeRootOnUnwind = false;
    let resumed = false;
    return {
      root,
      resume: () => {
        if (resumed) {
          return;
        }
        resumed = true;
        resumeTransportRoot(child, root, false);
      },
    };
  } finally {
    if (resumeRootOnUnwind) {
      if (expected) {
        // Orphans have no retained child handle. Failed inspection leaves the
        // registration intact; never release a reused PID while unwinding.
        const releaseDeadline = Date.now() + MAX_PROCESS_CONTAINMENT_MS;
        for (const descendant of stoppedDescendants.values()) {
          await signalSameProcess(descendant, "SIGCONT", releaseDeadline);
        }
        await signalSameRoot(root, "SIGCONT", releaseDeadline);
      } else {
        // A live parent still owns these stopped children when inspection fails.
        for (const descendant of stoppedDescendants.values()) {
          signalProcess(descendant.pid, "SIGCONT");
        }
        resumeTransportRoot(child, root, true);
      }
    }
  }
}

async function quiesceDescendants(
  root: PosixProcess,
  initialDescendants: PosixProcess[],
  stopped: Map<string, PosixProcess>,
  deadline: number,
): Promise<PosixProcess[] | undefined> {
  const provenByPid = new Map(initialDescendants.map((descendant) => [descendant.pid, descendant]));
  const stopFailures = new Map<string, number>();
  for (let pass = 0; pass < MAX_PROCESS_QUIESCE_PASSES; pass += 1) {
    if (Date.now() >= deadline) {
      return undefined;
    }
    const snapshot = await readCodexAppServerProcessSnapshot(deadline);
    if (!snapshot || Date.now() >= deadline) {
      return undefined;
    }
    const currentRoot = snapshot.find((row) => row.pid === root.pid);
    if (!currentRoot || !isSameLiveRoot(currentRoot, root)) {
      return undefined;
    }
    if (!isSameLiveRoot(currentRoot, root, true)) {
      if (!(await signalSameRoot(root, "SIGSTOP", deadline)) || Date.now() >= deadline) {
        return undefined;
      }
      continue;
    }
    const snapshotByPid = new Map(snapshot.map((process) => [process.pid, process]));
    const liveProven: PosixProcess[] = [];
    for (const proven of provenByPid.values()) {
      const current = snapshotByPid.get(proven.pid);
      if (!current) {
        provenByPid.delete(proven.pid);
        stopped.delete(identityKey(proven));
        continue;
      }
      if (!hasSameIdentity(proven, current)) {
        return undefined;
      }
      provenByPid.set(current.pid, current);
      const key = identityKey(current);
      if (stopped.has(key)) {
        stopped.set(key, current);
      }
      liveProven.push(current);
    }
    const descendants = collectDescendants(snapshot, [
      root.pid,
      ...liveProven.map(({ pid }) => pid),
    ]);
    for (const descendant of descendants) {
      const proven = provenByPid.get(descendant.pid);
      if (proven && !hasSameIdentity(proven, descendant)) {
        return undefined;
      }
      provenByPid.set(descendant.pid, descendant);
    }
    if (provenByPid.size > MAX_CONTAINED_PROCESSES) {
      return undefined;
    }
    const quiescenceTargets = new Map(liveProven.map((process) => [process.pid, process]));
    for (const descendant of descendants) {
      quiescenceTargets.set(descendant.pid, descendant);
    }
    let allStopped = true;
    for (const descendant of quiescenceTargets.values()) {
      if (Date.now() >= deadline) {
        return undefined;
      }
      if (isStoppedState(descendant.state)) {
        continue;
      }
      const stopQueued = await signalSameProcess(descendant, "SIGSTOP", deadline);
      if (Date.now() >= deadline) {
        return undefined;
      }
      if (stopQueued) {
        stopFailures.delete(identityKey(descendant));
        stopped.set(identityKey(descendant), descendant);
      } else {
        const key = identityKey(descendant);
        const failures = (stopFailures.get(key) ?? 0) + 1;
        if (failures >= 2) {
          return undefined;
        }
        stopFailures.set(key, failures);
      }
      if (!isUninterruptibleState(descendant.state) || !stopQueued) {
        allStopped = false;
      }
    }
    if (allStopped) {
      return [...provenByPid.values()];
    }
  }
  return undefined;
}

export async function readCodexAppServerProcessSnapshot(
  deadline = Date.now() + MAX_PROCESS_CONTAINMENT_MS,
): Promise<PosixProcess[] | undefined> {
  return await readProcesses(["-axo", PROCESS_COLUMNS], deadline);
}

async function readProcess(pid: number, deadline: number): Promise<PosixProcess | undefined> {
  return (await readProcesses(["-o", PROCESS_COLUMNS, "-p", String(pid)], deadline))?.find(
    (row) => row.pid === pid,
  );
}

async function readProcesses(
  args: string[],
  deadline: number,
): Promise<PosixProcess[] | undefined> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return undefined;
  }
  return await new Promise<PosixProcess[] | undefined>((resolve) => {
    let settled = false;
    const settle = (processes: PosixProcess[] | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(processes);
    };
    const inspector = execFile(
      "ps",
      args,
      {
        encoding: "utf8",
        maxBuffer: PROCESS_INSPECTION_MAX_BYTES,
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      },
      (error, stdout) => {
        settle(error ? undefined : parseProcesses(stdout));
      },
    );
    const timer = setTimeout(
      () => {
        settle(undefined);
        inspector.stdout?.destroy();
        inspector.stderr?.destroy();
        inspector.kill("SIGKILL");
        inspector.unref();
      },
      Math.max(1, remainingMs),
    );
    timer.unref?.();
  });
}

function parseProcesses(output: string): PosixProcess[] {
  const rows: PosixProcess[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const pid = Number(match[1] ?? "");
    const ppid = Number(match[2] ?? "");
    const pgid = Number(match[3] ?? "");
    const startedAt = (match[5] ?? "").trim().replace(/\s+/g, " ");
    if (
      ![pid, ppid, pgid].every(Number.isSafeInteger) ||
      pid <= 0 ||
      ppid < 0 ||
      pgid <= 0 ||
      !startedAt
    ) {
      continue;
    }
    rows.push({ pid, ppid, pgid, state: match[4] ?? "", startedAt });
  }
  return rows;
}

function collectDescendants(snapshot: PosixProcess[], rootPids: number[]): PosixProcess[] {
  const childrenByParent = new Map<number, PosixProcess[]>();
  for (const row of snapshot) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }
  const descendants: PosixProcess[] = [];
  const pending = [...new Set(rootPids)];
  const seen = new Set(pending);
  for (const parentPid of pending) {
    for (const child of childrenByParent.get(parentPid) ?? []) {
      if (seen.has(child.pid)) {
        continue;
      }
      seen.add(child.pid);
      descendants.push(child);
      pending.push(child.pid);
    }
  }
  return descendants;
}

function isStoppedState(state: string): boolean {
  return state.startsWith("T") || state.startsWith("t") || state.startsWith("Z");
}

function isQuiescedState(state: string): boolean {
  return isStoppedState(state) || isUninterruptibleState(state);
}

function isUninterruptibleState(state: string): boolean {
  return state.startsWith("D") || state.startsWith("U");
}

function isSameLiveProcess(
  current: PosixProcess,
  expected: CodexAppServerProcessIdentity,
): boolean {
  return (
    current.pgid === expected.pgid &&
    !current.state.startsWith("Z") &&
    hasSameIdentity(current, expected)
  );
}

function isSameLiveRoot(
  current: PosixProcess,
  expected: PosixProcess,
  requireStopped = false,
): boolean {
  return (
    current.ppid === expected.ppid &&
    (!requireStopped || isQuiescedState(current.state)) &&
    isSameLiveProcess(current, expected)
  );
}

async function signalSameRoot(
  root: PosixProcess,
  signal: NodeJS.Signals,
  deadline: number,
): Promise<boolean> {
  const current = await readProcess(root.pid, deadline);
  return Boolean(current && isSameLiveRoot(current, root) && signalProcess(current.pid, signal));
}

function resumeTransportRoot(
  child: ContainableTransport,
  root: PosixProcess,
  allowSynchronousPidFallback: boolean,
): void {
  try {
    if (child.kill) {
      child.kill("SIGCONT");
      return;
    }
  } catch {
    if (!allowSynchronousPidFallback) {
      return;
    }
  }
  if (allowSynchronousPidFallback) {
    // Failure unwind has not crossed an asynchronous boundary, so the saved
    // PID is still bounded to this synchronous stopped-root custody window.
    signalProcess(root.pid, "SIGCONT");
  }
}

async function signalSameProcess(
  expected: PosixProcess,
  signal: NodeJS.Signals,
  deadline: number,
): Promise<boolean> {
  // Portable Node POSIX signals are PID-based, so never retain numeric authority:
  // take this final identity snapshot synchronously immediately before every signal.
  const current = await readProcess(expected.pid, deadline);
  return Boolean(
    current && isSameLiveProcess(current, expected) && signalProcess(current.pid, signal),
  );
}

function hasSameIdentity(
  left: CodexAppServerProcessIdentity,
  right: CodexAppServerProcessIdentity,
): boolean {
  return identityKey(left) === identityKey(right);
}

function identityKey(row: CodexAppServerProcessIdentity): string {
  return `${row.pid}\0${row.startedAt}`;
}

function hasExited(child: ContainableTransport): boolean {
  return child.exitCode != null || child.signalCode != null;
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
