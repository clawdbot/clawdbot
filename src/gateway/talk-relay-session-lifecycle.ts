// Gateway Talk relay session lifecycle helpers.
// Enforces TTL and connection ownership for process-local relay sessions.
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";

/**
 * Shared TTL and connection-ownership checks for Talk relay session maps.
 */
type TalkRelayLifecycleSession = {
  connId: string;
  expiresAtMs: number;
};

type CloseTalkRelaySession<TSession extends TalkRelayLifecycleSession> = (
  session: TSession,
) => void;

function isExpiredTalkRelaySession(
  session: TalkRelayLifecycleSession,
  validNowMs: number,
): boolean {
  const expiresAtMs = asDateTimestampMs(session.expiresAtMs);
  return expiresAtMs === undefined || validNowMs > expiresAtMs;
}

/** Closes every expired relay session in the provided process-local map. */
export function closeExpiredTalkRelaySessions<TSession extends TalkRelayLifecycleSession>(params: {
  sessions: Iterable<TSession>;
  closeSession: CloseTalkRelaySession<TSession>;
  nowMs?: number;
}): void {
  const validNowMs = asDateTimestampMs(params.nowMs ?? Date.now());
  if (validNowMs === undefined) {
    return;
  }
  for (const session of params.sessions) {
    if (isExpiredTalkRelaySession(session, validNowMs)) {
      params.closeSession(session);
    }
  }
}

/** Returns the active session only when it belongs to the current connection. */
export function requireActiveTalkRelaySession<TSession extends TalkRelayLifecycleSession>(params: {
  sessions: ReadonlyMap<string, TSession>;
  sessionId: string;
  connId: string;
  closeSession: CloseTalkRelaySession<TSession>;
  unknownSessionMessage: string;
}): TSession {
  const session = params.sessions.get(params.sessionId);
  const nowMs = asDateTimestampMs(Date.now());
  if (
    !session ||
    session.connId !== params.connId ||
    nowMs === undefined ||
    isExpiredTalkRelaySession(session, nowMs)
  ) {
    // A stale or cross-connection id is closed before throwing so callers do
    // not leave provider sessions alive after ownership checks fail.
    if (session) {
      params.closeSession(session);
    }
    throw new Error(params.unknownSessionMessage);
  }
  return session;
}
