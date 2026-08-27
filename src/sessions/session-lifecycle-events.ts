/** Session lifecycle event broadcast to observers when a session is created or linked. */
import { resolveGlobalSet, resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
export type SessionLifecycleEvent = {
  sessionKey: string;
  agentId?: string;
  parentSessionKey?: string;
  label?: string;
  displayName?: string;
} & (
  | { reason: string; swarmGroupId?: never; kind?: never; text?: never }
  | { reason: "swarm-note"; swarmGroupId: string; kind: "phase" | "log"; text: string }
);

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
export type SessionIdentityMutationFence = {
  isCurrent: () => boolean;
  release: () => void;
};

type ActiveSessionIdentityMutationFence = SessionIdentityMutationFence & {
  invalidate: () => void;
};

const SESSION_IDENTITY_MUTATION_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionIdentityMutationState"),
  () => ({ version: 0 }),
);
const ACTIVE_SESSION_IDENTITY_MUTATION_FENCES = resolveGlobalSingleton(
  Symbol.for("openclaw.activeSessionIdentityMutationFences"),
  () => new Map<string, Set<ActiveSessionIdentityMutationFence>>(),
);
const SESSION_LIFECYCLE_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionLifecycleState"),
  () => ({ version: 0 }),
);

export function readSessionLifecycleVersion(): number {
  return SESSION_LIFECYCLE_STATE.version;
}

function listMutationIdentityKeys(target: SessionIdentityMutationTarget): string[] {
  return [
    ...target.sessionKeys.map((sessionKey) => `key:${sessionKey}`),
    ...(target.sessionId ? [`id:${target.sessionId}`] : []),
  ];
}

function addFence(identityKey: string, fence: ActiveSessionIdentityMutationFence): void {
  const fences = ACTIVE_SESSION_IDENTITY_MUTATION_FENCES.get(identityKey) ?? new Set();
  fences.add(fence);
  ACTIVE_SESSION_IDENTITY_MUTATION_FENCES.set(identityKey, fences);
}

function removeFence(identityKey: string, fence: ActiveSessionIdentityMutationFence): void {
  const fences = ACTIVE_SESSION_IDENTITY_MUTATION_FENCES.get(identityKey);
  if (!fences) {
    return;
  }
  fences.delete(fence);
  if (fences.size === 0) {
    ACTIVE_SESSION_IDENTITY_MUTATION_FENCES.delete(identityKey);
  }
}

/** Registers a session lifecycle listener. */
export function onSessionLifecycleEvent(listener: SessionLifecycleListener): () => void {
  return registerListener(SESSION_LIFECYCLE_LISTENERS, listener);
}

/** Emits a best-effort session lifecycle event to all listeners. */
export function emitSessionLifecycleEvent(event: SessionLifecycleEvent): void {
  SESSION_LIFECYCLE_STATE.version += 1;
  notifyListeners(SESSION_LIFECYCLE_LISTENERS, event);
}

export function onSessionIdentityMutation(listener: SessionIdentityMutationListener): () => void {
  return registerListener(SESSION_IDENTITY_MUTATION_LISTENERS, listener);
}

/** Monotonic fence for projections that consume session identities across owner boundaries. */
export function readSessionIdentityMutationVersion(): number {
  return SESSION_IDENTITY_MUTATION_STATE.version;
}

/** Registers a bounded fence for a projection currently reading one session identity. */
export function createSessionIdentityMutationFence(target: {
  sessionId?: string;
  sessionKey: string;
}): SessionIdentityMutationFence {
  let current = true;
  let released = false;
  const identityKeys = [
    `key:${target.sessionKey}`,
    ...(target.sessionId ? [`id:${target.sessionId}`] : []),
  ];
  const fence: ActiveSessionIdentityMutationFence = {
    isCurrent: () => current,
    invalidate: () => {
      current = false;
    },
    release: () => {
      if (released) {
        return;
      }
      released = true;
      for (const identityKey of identityKeys) {
        removeFence(identityKey, fence);
      }
    },
  };
  for (const identityKey of identityKeys) {
    addFence(identityKey, fence);
  }
  return fence;
}

export function emitSessionIdentityMutation(mutation: SessionIdentityMutation): void {
  SESSION_IDENTITY_MUTATION_STATE.version += 1;
  const targets =
    mutation.kind === "delete" ? [mutation.previous] : [mutation.previous, mutation.current];
  for (const identityKey of new Set(targets.flatMap(listMutationIdentityKeys))) {
    for (const fence of ACTIVE_SESSION_IDENTITY_MUTATION_FENCES.get(identityKey) ?? []) {
      fence.invalidate();
    }
  }
  notifyListeners(SESSION_IDENTITY_MUTATION_LISTENERS, mutation);
}
