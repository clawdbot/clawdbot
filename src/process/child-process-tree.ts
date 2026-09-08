import type { ChildProcess } from "node:child_process";
import { hasErrnoCode } from "../infra/errno.js";
import { signalProcessTree } from "./kill-tree.js";

export function shouldDetachChildForProcessTree(): boolean {
  return process.platform !== "win32";
}

export function isChildProcessTreeAlive(child: Pick<ChildProcess, "pid">): boolean {
  if (typeof child.pid !== "number" || child.pid <= 0) {
    return false;
  }
  const target = shouldDetachChildForProcessTree() ? -child.pid : child.pid;
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence. Permission or probe failures must retain cleanup.
    return !hasErrnoCode(error, "ESRCH");
  }
}

export function signalChildProcessTree(
  child: Pick<ChildProcess, "kill" | "pid">,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (typeof child.pid === "number" && child.pid > 0) {
    signalProcessTree(child.pid, signal, {
      detached: shouldDetachChildForProcessTree(),
    });
    return;
  }

  child.kill(signal);
}

export function forceKillChildProcessTree(child: Pick<ChildProcess, "kill" | "pid">): void {
  signalChildProcessTree(child, "SIGKILL");
}
