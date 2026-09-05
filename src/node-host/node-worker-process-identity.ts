import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";

export type NodeWorkerProcessIdentity = {
  pid: number;
  startTime: number;
};

type NodeWorkerProcessIdentityState = "live" | "dead" | "reused" | "unknown";

export function requireNodeWorkerProcessIdentity(pid: number): NodeWorkerProcessIdentity {
  const startTime = getFileLockProcessStartTime(pid);
  if (startTime === null) {
    throw new Error(`cannot establish PID-reuse-safe identity for process ${pid}`);
  }
  return { pid, startTime };
}

export function inspectNodeWorkerProcessIdentity(
  identity: NodeWorkerProcessIdentity,
): NodeWorkerProcessIdentityState {
  const observedStartTime = getFileLockProcessStartTime(identity.pid);
  if (observedStartTime !== null) {
    if (observedStartTime !== identity.startTime) {
      return "reused";
    }
    return isPidDefinitelyDead(identity.pid) ? "dead" : "live";
  }
  return isPidDefinitelyDead(identity.pid) ? "dead" : "unknown";
}
