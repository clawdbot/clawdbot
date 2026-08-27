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
type SessionIdentityMutationState = {
  version: number;
  versionsByIdentity: Map<string, number>;
};

const SESSION_IDENTITY_MUTATION_STATE = resolveGlobalSingleton<SessionIdentityMutationState>(
  Symbol.for("openclaw.sessionIdentityMutationState"),
  () => ({ version: 0, versionsByIdentity: new Map() }),
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

/** Monotonic fence scoped to one session key and optional concrete session identity. */
export function readSessionIdentityMutationVersionForTarget(
  target: Pick<SessionIdentityMutationTarget, "sessionId"> & { sessionKey: string },
): number {
  return Math.max(
    SESSION_IDENTITY_MUTATION_STATE.versionsByIdentity.get(`key:${target.sessionKey}`) ?? 0,
    target.sessionId
      ? (SESSION_IDENTITY_MUTATION_STATE.versionsByIdentity.get(`id:${target.sessionId}`) ?? 0)
      : 0,
  );
}

export function emitSessionIdentityMutation(mutation: SessionIdentityMutation): void {
  SESSION_IDENTITY_MUTATION_STATE.version += 1;
  const targets =
    mutation.kind === "delete" ? [mutation.previous] : [mutation.previous, mutation.current];
  for (const identityKey of new Set(targets.flatMap(listMutationIdentityKeys))) {
    SESSION_IDENTITY_MUTATION_STATE.versionsByIdentity.set(
      identityKey,
      SESSION_IDENTITY_MUTATION_STATE.version,
    );
  }
  notifyListeners(SESSION_IDENTITY_MUTATION_LISTENERS, mutation);
}
