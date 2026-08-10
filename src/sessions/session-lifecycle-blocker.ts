import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type SessionLifecycleBlockerKind = "code_mode_non_quiescent";

type SessionLifecycleBlocker = {
  kind: SessionLifecycleBlockerKind;
  identities: ReadonlySet<string>;
};

type SessionLifecycleBlockerState = {
  blockersByIdentity: Map<string, Set<SessionLifecycleBlocker>>;
};

export type SessionLifecycleBlockerLease = {
  release: () => void;
};

const SESSION_LIFECYCLE_BLOCKER_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionLifecycleBlockerState"),
  (): SessionLifecycleBlockerState => ({
    blockersByIdentity: new Map(),
  }),
);
const BLOCKERS_BY_IDENTITY = SESSION_LIFECYCLE_BLOCKER_STATE.blockersByIdentity;

function blockerMessage(kind: SessionLifecycleBlockerKind): string {
  return kind === "code_mode_non_quiescent"
    ? "Session still has non-quiescent Code Mode tool work; retry after it settles."
    : "Session lifecycle is blocked; retry after the active work settles.";
}

export class SessionLifecycleBlockedError extends Error {
  readonly kind: SessionLifecycleBlockerKind;
  readonly identities: readonly string[];

  constructor(kind: SessionLifecycleBlockerKind, identities: Iterable<string>) {
    super(blockerMessage(kind));
    this.name = "SessionLifecycleBlockedError";
    this.kind = kind;
    this.identities = Array.from(identities);
  }
}

export function isSessionLifecycleBlockedError(
  error: unknown,
): error is SessionLifecycleBlockedError {
  return (
    error instanceof SessionLifecycleBlockedError ||
    (error instanceof Error &&
      error.name === "SessionLifecycleBlockedError" &&
      "kind" in error &&
      error.kind === "code_mode_non_quiescent")
  );
}

export function resolveSessionLifecycleBlocker(
  normalizedIdentities: Iterable<string>,
): SessionLifecycleBlocker | undefined {
  for (const identity of normalizedIdentities) {
    const blocker = BLOCKERS_BY_IDENTITY.get(identity)?.values().next().value;
    if (blocker) {
      return blocker;
    }
  }
  return undefined;
}

export function assertSessionLifecycleUnblocked(normalizedIdentities: Iterable<string>): void {
  const blocker = resolveSessionLifecycleBlocker(normalizedIdentities);
  if (blocker) {
    throw new SessionLifecycleBlockedError(blocker.kind, blocker.identities);
  }
}

export function registerSessionLifecycleBlocker(params: {
  normalizedIdentities: Iterable<string>;
  kind: SessionLifecycleBlockerKind;
}): SessionLifecycleBlockerLease {
  const identities = new Set(params.normalizedIdentities);
  if (identities.size === 0) {
    throw new Error("session lifecycle blocker identities are required");
  }
  const blocker: SessionLifecycleBlocker = {
    kind: params.kind,
    identities,
  };
  for (const identity of identities) {
    const blockers = BLOCKERS_BY_IDENTITY.get(identity) ?? new Set();
    blockers.add(blocker);
    BLOCKERS_BY_IDENTITY.set(identity, blockers);
  }
  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      for (const identity of identities) {
        const blockers = BLOCKERS_BY_IDENTITY.get(identity);
        blockers?.delete(blocker);
        if (!blockers?.size) {
          BLOCKERS_BY_IDENTITY.delete(identity);
        }
      }
    },
  };
}

export function getActiveSessionLifecycleBlockerCount(): number {
  const blockers = new Set<SessionLifecycleBlocker>();
  for (const active of BLOCKERS_BY_IDENTITY.values()) {
    for (const blocker of active) {
      blockers.add(blocker);
    }
  }
  return blockers.size;
}
