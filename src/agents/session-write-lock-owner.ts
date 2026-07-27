import { AsyncLocalStorage } from "node:async_hooks";
import { SessionWriteLockTimeoutError } from "./session-write-lock-error.js";

export type SessionWriteLockOwnerIdentity = {
  kind: "agent-reply";
  runId: string;
};

type SessionWriteLockOwner = SessionWriteLockOwnerIdentity & {
  pidAlive: boolean;
  sessionFile: string;
};

const ownerContext = new AsyncLocalStorage<SessionWriteLockOwnerIdentity>();
const timeoutOwners = new WeakMap<object, SessionWriteLockOwner>();
const activeReplyRuns = new Map<string, Map<string, number>>();

export async function withActiveSessionWriteLockReplyRun<T>(
  owner: SessionWriteLockOwnerIdentity & { sessionFile: string },
  run: () => Promise<T>,
): Promise<T> {
  const sessionRuns = activeReplyRuns.get(owner.sessionFile) ?? new Map<string, number>();
  sessionRuns.set(owner.runId, (sessionRuns.get(owner.runId) ?? 0) + 1);
  activeReplyRuns.set(owner.sessionFile, sessionRuns);
  try {
    return await run();
  } finally {
    const remainingRegistrations = (sessionRuns.get(owner.runId) ?? 1) - 1;
    if (remainingRegistrations > 0) {
      sessionRuns.set(owner.runId, remainingRegistrations);
    } else {
      sessionRuns.delete(owner.runId);
    }
    if (sessionRuns.size === 0) {
      activeReplyRuns.delete(owner.sessionFile);
    }
  }
}

export function withSessionWriteLockOwner<T>(
  owner: SessionWriteLockOwnerIdentity,
  run: () => T,
): T {
  return ownerContext.run(owner, run);
}

export function getCurrentSessionWriteLockOwner(): SessionWriteLockOwnerIdentity | undefined {
  return ownerContext.getStore();
}

export function attachSessionWriteLockOwner(
  error: SessionWriteLockTimeoutError,
  owner: SessionWriteLockOwner | undefined,
): SessionWriteLockTimeoutError {
  if (owner) {
    timeoutOwners.set(error, owner);
  }
  return error;
}

export function isSessionWriteLockTimeoutOwnedByOtherReplyRun(
  error: unknown,
  currentRunId: string,
): boolean {
  if (!(error instanceof SessionWriteLockTimeoutError)) {
    return false;
  }
  const owner = timeoutOwners.get(error);
  return (
    owner?.kind === "agent-reply" &&
    owner.pidAlive &&
    owner.runId.length > 0 &&
    owner.runId !== currentRunId &&
    activeReplyRuns.get(owner.sessionFile)?.has(owner.runId) === true
  );
}
