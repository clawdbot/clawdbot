// Child process bridge adapts child process events into typed lifecycle callbacks.
import type { ChildProcess } from "node:child_process";
import process from "node:process";

/** Signal forwarding options for a child process bridge. */
export type ChildProcessBridgeOptions = {
  signals?: NodeJS.Signals[];
  onSignal?: (signal: NodeJS.Signals) => void;
};

const defaultSignals: NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGTERM", "SIGINT", "SIGBREAK"]
    : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];

/** Forwards process termination signals to a child and detaches on child exit/error. */
export function attachChildProcessBridge(
  child: ChildProcess,
  { signals = defaultSignals, onSignal }: ChildProcessBridgeOptions = {},
): { detach: () => void } {
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const listener = (): void => {
      onSignal?.(signal);
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    };
    try {
      process.on(signal, listener);
      listeners.set(signal, listener);
    } catch {
      // Unsupported signal on this platform.
    }
  }

  const detach = (): void => {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
    listeners.clear();
  };

  child.once("exit", detach);
  child.once("error", detach);

  return { detach };
}
