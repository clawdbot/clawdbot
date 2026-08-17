import { setTimeout as delay } from "node:timers/promises";
import { signalProcessTree } from "../process/kill-tree.js";
import {
  inspectNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";

type NodeWorkerTreeState = "live" | "dead" | "unknown";

const RECOVERY_POLL_MS = 25;

function inspectPosixProcessGroup(pid: number): NodeWorkerTreeState {
  try {
    process.kill(-pid, 0);
    return "live";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}

export function inspectOwnedNodeWorkerTree(worker: NodeWorkerProcessIdentity): NodeWorkerTreeState {
  const root = inspectNodeWorkerProcessIdentity(worker);
  if (root === "reused") {
    return "dead";
  }
  if (root === "live") {
    return "live";
  }
  if (root === "unknown") {
    return "unknown";
  }
  return process.platform === "win32" ? "dead" : inspectPosixProcessGroup(worker.pid);
}

export async function signalOwnedNodeWorkerTree(
  worker: NodeWorkerProcessIdentity,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  const root = inspectNodeWorkerProcessIdentity(worker);
  if (root === "reused" || root === "unknown") {
    return;
  }
  if (process.platform !== "win32") {
    if (inspectPosixProcessGroup(worker.pid) !== "live") {
      return;
    }
    // The detached worker PID is also its process-group id. Never fall back to
    // direct PID signaling after restart; a reused PID belongs to another tree.
    const revalidatedRoot = inspectNodeWorkerProcessIdentity(worker);
    if (revalidatedRoot === "reused" || revalidatedRoot === "unknown") {
      return;
    }
    try {
      process.kill(-worker.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
    return;
  }
  if (root !== "live" || inspectNodeWorkerProcessIdentity(worker) !== "live") {
    return;
  }
  await new Promise<void>((resolve) => {
    signalProcessTree(worker.pid, signal, { detached: true, onComplete: resolve });
  });
}

export async function waitForOwnedNodeWorkerTreeDeath(
  worker: NodeWorkerProcessIdentity,
  timeoutMs: number,
): Promise<NodeWorkerTreeState> {
  const deadline = Date.now() + timeoutMs;
  let state = inspectOwnedNodeWorkerTree(worker);
  while (state === "live" && Date.now() < deadline) {
    await delay(RECOVERY_POLL_MS);
    state = inspectOwnedNodeWorkerTree(worker);
  }
  return state;
}
