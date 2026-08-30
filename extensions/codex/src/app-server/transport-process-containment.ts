import {
  readCodexAppServerProcess,
  readCodexAppServerProcessSnapshot,
  type PosixProcess,
} from "./transport-process-snapshot.js";

type ContainableTransport = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
  kill?: (signal?: NodeJS.Signals) => unknown;
};

export type CodexAppServerProcessIdentity = Pick<PosixProcess, "pid" | "pgid" | "startedAt">;

const MAX_CONTAINED_PROCESSES = 512;
const MAX_PROCESS_CONTAINMENT_MS = 2_000;
const MAX_PROCESS_QUIESCE_PASSES = 16;

export async function terminateCodexAppServerDescendants(
  child: ContainableTransport,
): Promise<(() => void) | "exited" | undefined> {
  const contained = await containDescendants(child);
  return contained === "exited" ? contained : contained?.resume;
}

/** A durable spawn fact, never a command-line match, selects the orphan root. */
export async function terminateCodexAppServerOrphan(
  expected: CodexAppServerProcessIdentity,
): Promise<boolean> {
  const deadline = Date.now() + MAX_PROCESS_CONTAINMENT_MS;
  const result = await containDescendants(
    { pid: expected.pid, kill: (signal) => signalProcess(expected.pid, signal ?? "SIGTERM") },
    expected,
    deadline,
  );
  const contained = result === "exited" ? undefined : result;
  let gone = false;
  try {
    if (contained) {
      const current = await readCodexAppServerProcess(expected.pid, deadline);
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
): Promise<{ root: PosixProcess; resume: () => void } | "exited" | undefined> {
  const rootPid = child.pid;
  if (hasExited(child)) {
    return "exited";
  }
  if (process.platform === "win32" || !rootPid || !child.kill) {
    return undefined;
  }
  const snapshot = await readCodexAppServerProcessSnapshot(deadline);
  if (!snapshot || Date.now() >= deadline) {
    return undefined;
  }
  const root = snapshot.find((row) => row.pid === rootPid);
  // A retained direct child cannot have its PID reused before Node reaps it.
  // Preserve an OS-observed exit even when Node's exit callback is still queued.
  if (!expected && (!root || root.state.startsWith("Z"))) {
    return "exited";
  }
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
  const current = await readCodexAppServerProcess(root.pid, deadline);
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
  const current = await readCodexAppServerProcess(expected.pid, deadline);
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
