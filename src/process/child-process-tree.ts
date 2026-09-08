import type { ChildProcess } from "node:child_process";
import { hasErrnoCode } from "../infra/errno.js";
import { signalProcessTree } from "./kill-tree.js";
import { scheduleAdoptedChildZombieReapAfterExit } from "./scoped-child-reaper.js";

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
  child: Pick<ChildProcess, "kill" | "pid" | "exitCode" | "signalCode" | "once">,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (typeof child.pid === "number" && child.pid > 0) {
    const usedProcessGroup = shouldDetachChildForProcessTree();
    signalProcessTree(child.pid, signal, {
      detached: usedProcessGroup,
    });
    // Tree kills can leave already-exited descendants reparented to us as
    // untracked zombies (#97616). Reap after the Node-tracked root exits so
    // libuv keeps ownership of its wait status — never waitpid the root, and
    // never waitpid(-1).
    scheduleAdoptedChildZombieReapAfterExit(child, usedProcessGroup);
    return;
  }

  child.kill(signal);
}

export function forceKillChildProcessTree(
  child: Pick<ChildProcess, "kill" | "pid" | "exitCode" | "signalCode" | "once">,
): void {
  signalChildProcessTree(child, "SIGKILL");
}
