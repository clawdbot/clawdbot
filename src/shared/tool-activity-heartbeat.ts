const runListeners = new Map<string, Set<() => void>>();
const runLastActivityMs = new Map<string, number>();

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
