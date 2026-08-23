import { readWindowsProcessStartTimeSync } from "../infra/windows-port-pids.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";

export type NodeWorkerProcessIdentity = {
  pid: number;
  startTime: number;
};

type NodeWorkerProcessIdentityState = "live" | "dead" | "reused" | "unknown";

function readNodeWorkerProcessStartTime(pid: number): number | null {
  return process.platform === "win32"
    ? readWindowsProcessStartTimeSync(pid)
    : getFileLockProcessStartTime(pid);
}

export function requireNodeWorkerProcessIdentity(pid: number): NodeWorkerProcessIdentity {
  const startTime = readNodeWorkerProcessStartTime(pid);
  if (startTime === null) {
    throw new Error(`cannot establish PID-reuse-safe identity for process ${pid}`);
  }
  return { pid, startTime };
}

export function inspectNodeWorkerProcessIdentity(
  identity: NodeWorkerProcessIdentity,
): NodeWorkerProcessIdentityState {
  const observedStartTime = readNodeWorkerProcessStartTime(identity.pid);
  if (observedStartTime !== null) {
    if (observedStartTime !== identity.startTime) {
      return "reused";
    }
    return isPidDefinitelyDead(identity.pid) ? "dead" : "live";
  }
  return isPidDefinitelyDead(identity.pid) ? "dead" : "unknown";
}
