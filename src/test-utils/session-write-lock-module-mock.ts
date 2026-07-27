// Typed mock facade for session write-lock module tests.
import type * as SessionWriteLockModule from "../agents/session-write-lock.js";

type SessionWriteLockModuleShape = typeof SessionWriteLockModule;

/** Creates a session-write-lock module mock while preserving untouched exports. */
export async function buildSessionWriteLockModuleMock(
  loadActual: () => Promise<SessionWriteLockModuleShape>,
  acquireSessionWriteLock: SessionWriteLockModuleShape["acquireSessionWriteLock"],
): Promise<SessionWriteLockModuleShape> {
  const original = await loadActual();
  return {
    ...original,
    acquireSessionWriteLock,
  };
}
