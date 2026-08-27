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
const talkConnectionCleanups = resolveGlobalMap<string, Map<TalkConnectionCleanupKind, () => void>>(
  Symbol.for("openclaw.talkConnectionCleanups"),
  "close-and-restart",
);

/**
 * Keeps one owner cleanup per relay kind until the connection closes.
 * Replacing by kind stays bounded while the owner cleanup scans all live sessions.
 */
export function registerTalkConnectionCleanup(
  connId: string,
  kind: TalkConnectionCleanupKind,
  cleanup: () => void,
): void {
  const cleanups =
    talkConnectionCleanups.get(connId) ?? new Map<TalkConnectionCleanupKind, () => void>();
  cleanups.set(kind, cleanup);
  talkConnectionCleanups.set(connId, cleanups);
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
  for (const [kind, cleanup] of cleanups) {
    try {
      cleanup();
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
