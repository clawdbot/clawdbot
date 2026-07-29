/** Cleanup callback for resources tied to an LLM session or all sessions. */
export type SessionResourceCleanup = (sessionId?: string) => void;

// Process-local registry of cleanup hooks owned by LLM providers/transports.
const sessionResourceCleanups = new Set<SessionResourceCleanup>();

/** Registers a session-resource cleanup hook and returns an unregister function. */
export function registerSessionResourceCleanup(cleanup: SessionResourceCleanup): () => void {
  sessionResourceCleanups.add(cleanup);
  return () => {
    sessionResourceCleanups.delete(cleanup);
  };
}

/** Runs all registered cleanup hooks, aggregating failures after every hook has run. */
export function cleanupSessionResources(sessionId?: string): void {
  const errors: unknown[] = [];
  for (const cleanup of sessionResourceCleanups) {
    try {
      cleanup(sessionId);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to cleanup session resources");
  }
}
