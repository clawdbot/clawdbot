// ACP Core module implements session behavior.
import { randomUUID } from "node:crypto";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import type { AcpSession } from "./types.js";

export type AcpSessionStore = {
  /** Creates or refreshes an in-memory ACP session under the supplied session id. */
  createSession: (params: {
    sessionKey: string;
    cwd: string;
    sessionId?: string;
    ledgerSessionId?: string;
  }) => AcpSession;
  hasSession: (sessionId: string) => boolean;
  getSession: (sessionId: string) => AcpSession | undefined;
  /** Binds an active runtime run to a session so cancel/close can abort it later. */
  setActiveRun: (sessionId: string, runId: string, abortController: AbortController) => void;
  clearActiveRun: (sessionId: string, expectedRunId?: string) => void;
  cancelActiveRun: (sessionId: string, expectedRunId?: string) => boolean;
  deleteSession: (sessionId: string) => boolean;
};

type InMemoryAcpSessionStore = AcpSessionStore & {
  /** Releases every record when the registry's lifecycle owner shuts down. */
  dispose: () => void;
};

type AcpSessionStoreOptions = {
  maxSessions?: number;
  idleTtlMs?: number;
  now?: () => number;
};

const DEFAULT_MAX_SESSIONS = 5_000;
const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1_000;

/** Creates the bounded in-memory ACP session registry used by local ACP runtime clients. */
export function createInMemorySessionStore(
  options: AcpSessionStoreOptions = {},
): InMemoryAcpSessionStore {
  const maxSessions = resolveIntegerOption(options.maxSessions, DEFAULT_MAX_SESSIONS, { min: 1 });
  const idleTtlMs = resolveIntegerOption(options.idleTtlMs, DEFAULT_IDLE_TTL_MS, { min: 1_000 });
  const now = options.now ?? Date.now;
  const sessions = new Map<string, AcpSession>();

  const touchSession = (session: AcpSession, nowMs: number) => {
    session.lastTouchedAt = nowMs;
  };

  const removeSession = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.abortController?.abort();
    sessions.delete(sessionId);
    return true;
  };

  const reapIdleSessions = (nowMs: number) => {
    const idleBefore = nowMs - idleTtlMs;
    for (const [sessionId, session] of sessions.entries()) {
      if (session.activeRunId || session.abortController) {
        continue;
      }
      if (session.lastTouchedAt > idleBefore) {
        continue;
      }
      removeSession(sessionId);
    }
  };

  const evictOldestIdleSession = () => {
    let oldestSessionId: string | null = null;
    let oldestLastTouchedAt = Number.POSITIVE_INFINITY;
    for (const [sessionId, session] of sessions.entries()) {
      if (session.activeRunId || session.abortController) {
        continue;
      }
      if (session.lastTouchedAt >= oldestLastTouchedAt) {
        continue;
      }
      oldestLastTouchedAt = session.lastTouchedAt;
      oldestSessionId = sessionId;
    }
    if (!oldestSessionId) {
      return false;
    }
    return removeSession(oldestSessionId);
  };

  const createSession: AcpSessionStore["createSession"] = (params) => {
    const nowMs = now();
    const sessionId = params.sessionId ?? randomUUID();
    const existingSession = sessions.get(sessionId);
    if (existingSession) {
      existingSession.sessionKey = params.sessionKey;
      if ("ledgerSessionId" in params) {
        existingSession.ledgerSessionId = params.ledgerSessionId;
      }
      existingSession.cwd = params.cwd;
      touchSession(existingSession, nowMs);
      return existingSession;
    }
    reapIdleSessions(nowMs);
    // Active runs are never evicted to make cancellation ownership explicit; callers must
    // clear/cancel them before the soft cap can make room.
    if (sessions.size >= maxSessions && !evictOldestIdleSession()) {
      throw new Error(
        `ACP session limit reached (max ${maxSessions}). Close idle ACP clients and retry.`,
      );
    }
    const session: AcpSession = {
      sessionId,
      sessionKey: params.sessionKey,
      ...(params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {}),
      cwd: params.cwd,
      createdAt: nowMs,
      lastTouchedAt: nowMs,
      abortController: null,
      activeRunId: null,
    };
    sessions.set(sessionId, session);
    return session;
  };

  const hasSession: AcpSessionStore["hasSession"] = (sessionId) => sessions.has(sessionId);

  const getSession: AcpSessionStore["getSession"] = (sessionId) => {
    const session = sessions.get(sessionId);
    if (session) {
      touchSession(session, now());
    }
    return session;
  };

  const setActiveRun: AcpSessionStore["setActiveRun"] = (sessionId, runId, abortController) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.activeRunId = runId;
    session.abortController = abortController;
    touchSession(session, now());
  };

  const releaseActiveRun = (session: AcpSession) => {
    session.activeRunId = null;
    session.abortController = null;
    touchSession(session, now());
  };

  const clearActiveRun: AcpSessionStore["clearActiveRun"] = (sessionId, expectedRunId) => {
    const session = sessions.get(sessionId);
    if (session && (expectedRunId === undefined || session.activeRunId === expectedRunId)) {
      releaseActiveRun(session);
    }
  };

  const cancelActiveRun: AcpSessionStore["cancelActiveRun"] = (sessionId, expectedRunId) => {
    const session = sessions.get(sessionId);
    if (
      !session?.abortController ||
      (expectedRunId !== undefined && session.activeRunId !== expectedRunId)
    ) {
      return false;
    }
    session.abortController.abort();
    releaseActiveRun(session);
    return true;
  };

  const deleteSession: AcpSessionStore["deleteSession"] = (sessionId) => removeSession(sessionId);

  const dispose: InMemoryAcpSessionStore["dispose"] = () => {
    for (const session of sessions.values()) {
      session.abortController?.abort();
    }
    sessions.clear();
  };

  return {
    createSession,
    hasSession,
    getSession,
    setActiveRun,
    clearActiveRun,
    cancelActiveRun,
    deleteSession,
    dispose,
  };
}
