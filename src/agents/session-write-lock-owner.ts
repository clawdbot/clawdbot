import { AsyncLocalStorage } from "node:async_hooks";
import { SessionWriteLockTimeoutError } from "./session-write-lock-error.js";

export type SessionWriteLockOwnerIdentity = {
  kind: "agent-reply";
  runId: string;
};

type SessionWriteLockOwner = SessionWriteLockOwnerIdentity & {
  pidAlive: boolean;
};

const ownerContext = new AsyncLocalStorage<SessionWriteLockOwnerIdentity>();
const timeoutOwners = new WeakMap<object, SessionWriteLockOwner>();

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
    owner.runId !== currentRunId
  );
}
