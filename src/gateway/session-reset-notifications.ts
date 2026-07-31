type GatewaySessionResetListener = (sessionKey: string) => void;

const listeners = new Set<GatewaySessionResetListener>();

/** Subscribes process-local lifecycle services to committed session resets. */
export function onGatewaySessionReset(listener: GatewaySessionResetListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Notifies lifecycle-owned in-memory services after the session reset commits. */
export function notifyGatewaySessionReset(sessionKey: string): void {
  for (const listener of listeners) {
    try {
      listener(sessionKey);
    } catch {
      // A process-local cleanup listener must not turn a committed reset into
      // an apparent failure or prevent the remaining lifecycle owners running.
    }
  }
}
