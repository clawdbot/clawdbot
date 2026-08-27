/**
 * Process-local registry that lets Talk protocol methods resolve opaque
 * `sessionId` values to the concrete relay or managed-room backend.
 */
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { formatError } from "./server-utils.js";

type TalkConnectionCleanupKind = "browser-control" | "realtime-relay" | "transcription-relay";

type UnifiedTalkSessionRecord =
  | {
      kind: "realtime-relay";
      connId: string;
      relaySessionId: string;
    }
  | {
      kind: "transcription-relay";
      connId: string;
      transcriptionSessionId: string;
    }
  | {
      kind: "managed-room";
      handoffId: string;
      token: string;
      roomId: string;
    };

const unifiedTalkSessions = resolveGlobalMap<string, UnifiedTalkSessionRecord>(
  Symbol.for("openclaw.unifiedTalkSessions"),
  "close-and-restart",
);
type TalkConnectionCleanupRegistration = {
  cleanup: () => void;
  owners: Set<symbol>;
};

const talkConnectionCleanups = resolveGlobalMap<
  string,
  Map<TalkConnectionCleanupKind, TalkConnectionCleanupRegistration>
>(Symbol.for("openclaw.talkConnectionCleanups"), "close-and-restart");

/**
 * Keeps one cleanup per relay kind and returns a release for this registration.
 * The cleanup remains available until the connection closes or its final owner releases it.
 */
export function registerTalkConnectionCleanup(
  connId: string,
  kind: TalkConnectionCleanupKind,
  cleanup: () => void,
): () => void {
  const cleanups =
    talkConnectionCleanups.get(connId) ??
    new Map<TalkConnectionCleanupKind, TalkConnectionCleanupRegistration>();
  const registration = cleanups.get(kind) ?? { cleanup, owners: new Set<symbol>() };
  const owner = Symbol(kind);
  registration.cleanup = cleanup;
  registration.owners.add(owner);
  cleanups.set(kind, registration);
  talkConnectionCleanups.set(connId, cleanups);
  return () => {
    const currentCleanups = talkConnectionCleanups.get(connId);
    if (!currentCleanups) {
      return;
    }
    const currentRegistration = currentCleanups.get(kind);
    if (currentRegistration !== registration || !registration.owners.delete(owner)) {
      return;
    }
    if (registration.owners.size > 0) {
      return;
    }
    currentCleanups.delete(kind);
    if (currentCleanups.size === 0) {
      talkConnectionCleanups.delete(connId);
    }
  };
}

/** Runs and forgets every Talk cleanup owned by a disconnected gateway connection. */
export function cleanupTalkConnection(
  connId: string,
  log: { warn: (message: string) => void },
): void {
  const cleanups = talkConnectionCleanups.get(connId);
  if (!cleanups) {
    return;
  }
  // Delete first so cleanup failures or re-entrancy cannot retain stale connection owners.
  talkConnectionCleanups.delete(connId);
  for (const [kind, registration] of cleanups) {
    try {
      registration.cleanup();
    } catch (error) {
      log.warn(
        `failed to run ${kind} Talk cleanup after connection disconnect: ${formatError(error)}`,
      );
    }
  }
}

/** Associates a public Talk session id with its concrete gateway backend. */
export function rememberUnifiedTalkSession(
  sessionId: string,
  session: UnifiedTalkSessionRecord,
): void {
  unifiedTalkSessions.set(sessionId, session);
}

/** Resolves a Talk session id or throws the protocol-facing unknown-session error. */
export function getUnifiedTalkSession(sessionId: string): UnifiedTalkSessionRecord {
  const session = unifiedTalkSessions.get(sessionId);
  if (!session) {
    throw new Error("Unknown Talk session");
  }
  return session;
}

/** Removes a Talk session id after the concrete backend closes. */
export function forgetUnifiedTalkSession(sessionId: string): void {
  unifiedTalkSessions.delete(sessionId);
}

/** Enforces that a relay-backed Talk session is controlled by its owner socket. */
export function requireUnifiedTalkSessionConn(
  session: Extract<UnifiedTalkSessionRecord, { connId: string }>,
  connId: string | undefined,
): string {
  if (!connId || session.connId !== connId) {
    throw new Error("Talk session is not owned by this connection");
  }
  return connId;
}
