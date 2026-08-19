import { spawnSync } from "node:child_process";

type ContainableTransport = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
};

type PosixProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  startedAt: string;
};

const MAX_PROCESS_QUIESCE_PASSES = 8;
const PROCESS_COLUMNS = "pid=,ppid=,pgid=,stat=,lstart=";

export function terminateCodexAppServerDescendants(child: ContainableTransport): void {
  const rootPid = child.pid;
  if (process.platform === "win32" || !rootPid || hasExited(child)) {
    return;
  }
  const snapshot = readProcessSnapshot();
  if (!snapshot) {
    return;
  }
  const root = snapshot.find((row) => row.pid === rootPid);
  if (!root || !isSameLiveRoot(root, root)) {
    return;
  }

  const initialDescendants = collectDescendants(snapshot, rootPid);
  const stoppedDescendants = new Map<string, PosixProcess>();
  if (!signalSameRoot(root, "SIGSTOP")) {
    return;
  }
  try {
    const descendants = quiesceDescendants(root, initialDescendants, stoppedDescendants);
    if (!descendants) {
      return;
    }

    // Parents are last: every destructive signal revalidates the exact live PID
    // while the stopped ancestry still prevents new descendants.
    for (const descendant of descendants.toReversed()) {
      if (!descendant.state.startsWith("Z")) {
        signalSameProcess(descendant, "SIGKILL");
      }
    }
  } finally {
    for (const descendant of stoppedDescendants.values()) {
      signalSameProcess(descendant, "SIGCONT");
    }
    signalSameRoot(root, "SIGCONT");
  }
}

function quiesceDescendants(
  root: PosixProcess,
  initialDescendants: PosixProcess[],
  stopped: Map<string, PosixProcess>,
): PosixProcess[] | undefined {
  const provenByPid = new Map(initialDescendants.map((descendant) => [descendant.pid, descendant]));
  for (let pass = 0; pass < MAX_PROCESS_QUIESCE_PASSES; pass += 1) {
    const snapshot = readProcessSnapshot();
    if (!snapshot) {
      return undefined;
    }
    const currentRoot = snapshot.find((row) => row.pid === root.pid);
    if (!currentRoot || !isSameLiveRoot(currentRoot, root)) {
      return undefined;
    }
    if (!isSameLiveRoot(currentRoot, root, true)) {
      continue;
    }
    const descendants = collectDescendants(snapshot, root.pid);
    for (const descendant of descendants) {
      const proven = provenByPid.get(descendant.pid);
      if (proven && !hasSameIdentity(proven, descendant)) {
        return undefined;
      }
      provenByPid.set(descendant.pid, descendant);
    }
    let allStopped = true;
    for (const descendant of descendants) {
      if (descendant.state.startsWith("T") || descendant.state.startsWith("Z")) {
        continue;
      }
      allStopped = false;
      if (signalSameProcess(descendant, "SIGSTOP")) {
        stopped.set(identityKey(descendant), descendant);
      }
    }
    if (allStopped) {
      return [...provenByPid.values()];
    }
  }
  // Bounded quiescence must not fail open. Kill every identity proven while it
  // belonged to the stopped root, including processes that have since reparented.
  return [...provenByPid.values()];
}

function readProcessSnapshot(): PosixProcess[] | undefined {
  return readProcesses(["-axo", PROCESS_COLUMNS]);
}

function readProcess(pid: number): PosixProcess | undefined {
  return readProcesses(["-o", PROCESS_COLUMNS, "-p", String(pid)])?.find((row) => row.pid === pid);
}

function readProcesses(args: string[]): PosixProcess[] | undefined {
  try {
    const result = spawnSync("ps", args, { encoding: "utf8", timeout: 500 });
    if (result.error || result.status !== 0) {
      return undefined;
    }
    return parseProcesses(result.stdout);
  } catch {
    return undefined;
  }
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

function collectDescendants(snapshot: PosixProcess[], rootPid: number): PosixProcess[] {
  const childrenByParent = new Map<number, PosixProcess[]>();
  for (const row of snapshot) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }
  const descendants: PosixProcess[] = [];
  const pending = [rootPid];
  for (const parentPid of pending) {
    for (const child of childrenByParent.get(parentPid) ?? []) {
      descendants.push(child);
      pending.push(child.pid);
    }
  }
  return descendants;
}

function isSameLiveProcess(current: PosixProcess, expected: PosixProcess): boolean {
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
    current.ppid === process.pid &&
    (!requireStopped || current.state.startsWith("T")) &&
    isSameLiveProcess(current, expected)
  );
}

function signalSameRoot(root: PosixProcess, signal: NodeJS.Signals): boolean {
  const current = readProcess(root.pid);
  return Boolean(current && isSameLiveRoot(current, root) && signalProcess(current.pid, signal));
}

function signalSameProcess(expected: PosixProcess, signal: NodeJS.Signals): boolean {
  // Portable Node POSIX signals are PID-based, so never retain numeric authority:
  // take this final identity snapshot synchronously immediately before every signal.
  const current = readProcess(expected.pid);
  return Boolean(
    current && isSameLiveProcess(current, expected) && signalProcess(current.pid, signal),
  );
}

function hasSameIdentity(left: PosixProcess, right: PosixProcess): boolean {
  return identityKey(left) === identityKey(right);
}

function identityKey(row: PosixProcess): string {
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
