/** Session lifecycle event broadcast to observers when a session is created or linked. */
import { resolveGlobalSet, resolveGlobalSingleton } from "../shared/global-singleton.js";
export type SessionLifecycleEvent = {
  sessionKey: string;
  reason: string;
  parentSessionKey?: string;
  label?: string;
  displayName?: string;
};

export type SessionIdentityMutationTarget = {
  sessionId?: string;
  sessionKeys: readonly string[];
};

export type SessionIdentityMutation =
  | {
      kind: "create" | "move" | "replace" | "reset";
      previous: SessionIdentityMutationTarget;
      current: SessionIdentityMutationTarget;
    }
  | {
      kind: "delete";
      previous: SessionIdentityMutationTarget;
    };

export type SessionIdentityMutationListener = (mutation: SessionIdentityMutation) => void;

type SessionLifecycleListener = (event: SessionLifecycleEvent) => void;

const SESSION_LIFECYCLE_LISTENERS = resolveGlobalSet<SessionLifecycleListener>(
  Symbol.for("openclaw.sessionLifecycleEventListeners"),
  "close-and-restart",
);
const SESSION_IDENTITY_MUTATION_LISTENERS = resolveGlobalSet<SessionIdentityMutationListener>(
  Symbol.for("openclaw.sessionIdentityMutationListeners"),
  "close-and-restart",
);
const SESSION_IDENTITY_MUTATION_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionIdentityMutationState"),
  () => ({ version: 0 }),
);

/** Registers a session lifecycle listener. */
export function onSessionLifecycleEvent(listener: SessionLifecycleListener): () => void {
  SESSION_LIFECYCLE_LISTENERS.add(listener);
  return () => {
    SESSION_LIFECYCLE_LISTENERS.delete(listener);
  };
}

/** Emits a best-effort session lifecycle event to all listeners. */
export function emitSessionLifecycleEvent(event: SessionLifecycleEvent): void {
  for (const listener of SESSION_LIFECYCLE_LISTENERS) {
    try {
      listener(event);
    } catch {
      // Best-effort, do not propagate listener errors.
    }
  }
}

export function onSessionIdentityMutation(listener: SessionIdentityMutationListener): () => void {
  SESSION_IDENTITY_MUTATION_LISTENERS.add(listener);
  return () => {
    SESSION_IDENTITY_MUTATION_LISTENERS.delete(listener);
  };
}

/** Monotonic fence for projections that consume session identities across owner boundaries. */
export function readSessionIdentityMutationVersion(): number {
  return SESSION_IDENTITY_MUTATION_STATE.version;
}

export function emitSessionIdentityMutation(mutation: SessionIdentityMutation): void {
  SESSION_IDENTITY_MUTATION_STATE.version += 1;
  for (const listener of SESSION_IDENTITY_MUTATION_LISTENERS) {
    try {
      listener(mutation);
    } catch {
      // Session persistence already succeeded; one observer must not block the rest.
    }
  }
}
