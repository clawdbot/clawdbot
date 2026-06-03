import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";

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
    if (session) {
      params.closeSession(session);
    }
    throw new Error(params.unknownSessionMessage);
  }
  return session;
}
