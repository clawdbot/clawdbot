import type { ChildProcess } from "node:child_process";
import { signalProcessTree } from "./kill-tree.js";
import { reapOwnedChildZombiesAfterTreeKill } from "./scoped-child-reaper.js";

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
  } catch {
    return false;
  }
}

export function signalChildProcessTree(
  child: Pick<ChildProcess, "kill" | "pid">,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (typeof child.pid === "number" && child.pid > 0) {
    const usedProcessGroup = shouldDetachChildForProcessTree();
    signalProcessTree(child.pid, signal, {
      detached: usedProcessGroup,
    });
    // Tree kills can leave already-exited descendants reparented to us as
    // untracked zombies (#97616). Reap only this root/pgid scope — never -1.
    reapOwnedChildZombiesAfterTreeKill({
      rootPid: child.pid,
      usedProcessGroup,
    });
    return;
  }

  child.kill(signal);
}

export function forceKillChildProcessTree(child: Pick<ChildProcess, "kill" | "pid">): void {
  signalChildProcessTree(child, "SIGKILL");
}
