import type { ChildProcess } from "node:child_process";
import { signalProcessTree } from "./kill-tree.js";

export function shouldDetachChildForProcessTree(): boolean {
  return process.platform !== "win32";
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
