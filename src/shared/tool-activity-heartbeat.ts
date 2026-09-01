import { resolveGlobalSingleton } from "./global-singleton.js";
import { notifyListeners } from "./listeners.js";

const { runListeners, runLastActivityMs } = resolveGlobalSingleton(
  Symbol.for("openclaw.toolActivityHeartbeat"),
  () => ({
    runListeners: new Map<string, Set<() => void>>(),
    runLastActivityMs: new Map<string, number>(),
  }),
  (state) => {
    for (const listeners of state.runListeners.values()) {
      notifyListeners(listeners, undefined);
    }
    state.runListeners.clear();
    state.runLastActivityMs.clear();
  },
);

export function notifyToolActivity(runId: string): void {
  runLastActivityMs.set(runId, Date.now());
  const listeners = runListeners.get(runId);
  if (!listeners) {
    return;
  }
  for (const listener of listeners) {
    listener();
  }
}

export function onToolActivity(runId: string, listener: () => void): () => void {
  let listeners = runListeners.get(runId);
  if (!listeners) {
    listeners = new Set();
    runListeners.set(runId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      runListeners.delete(runId);
    }
  };
}

export function getLastToolActivityMs(runId: string): number {
  return runLastActivityMs.get(runId) ?? 0;
}

export function clearToolActivityRun(runId: string): void {
  runListeners.delete(runId);
  runLastActivityMs.delete(runId);
}
