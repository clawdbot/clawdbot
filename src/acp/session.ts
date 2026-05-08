import { randomUUID } from "node:crypto";
import type { AcpSession } from "./types.js";

export type AcpSessionStore = {
  createSession: (params: {
    sessionKey: string;
    cwd: string;
    sessionId?: string;
    ledgerSessionId?: string;
  }) => AcpSession;
  hasSession: (sessionId: string) => boolean;
  getSession: (sessionId: string) => AcpSession | undefined;
  getSessionByRunId: (runId: string) => AcpSession | undefined;
  setActiveRun: (sessionId: string, runId: string, abortController: AbortController) => void;
  clearActiveRun: (sessionId: string) => void;
  cancelActiveRun: (sessionId: string) => boolean;
  deleteSession: (sessionId: string) => boolean;
  clearAllSessionsForTest: () => void;
};

type AcpSessionStoreOptions = {
  maxSessions?: number;
  idleTtlMs?: number;
  now?: () => number;
};

const DEFAULT_MAX_SESSIONS = 5_000;
const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1_000;

export function createInMemorySessionStore(options: AcpSessionStoreOptions = {}): AcpSessionStore {
  const maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
  const idleTtlMs = Math.max(1_000, options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS);
  const now = options.now ?? Date.now;
  const sessions = new Map<string, AcpSession>();
  const runIdToSessionId = new Map<string, string>();

  const touchSession = (session: AcpSession, nowMs: number) => {
    session.lastTouchedAt = nowMs;
  };

  const removeSession = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return false;
    }
    if (session.activeRunId) {
      runIdToSessionId.delete(session.activeRunId);
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

  const getSessionByRunId: AcpSessionStore["getSessionByRunId"] = (runId) => {
    const sessionId = runIdToSessionId.get(runId);
    if (!sessionId) {
      return undefined;
    }
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
    runIdToSessionId.set(runId, sessionId);
    touchSession(session, now());
  };

  const clearActiveRun: AcpSessionStore["clearActiveRun"] = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (session.activeRunId) {
      runIdToSessionId.delete(session.activeRunId);
    }
    session.activeRunId = null;
    session.abortController = null;
    touchSession(session, now());
  };

  const cancelActiveRun: AcpSessionStore["cancelActiveRun"] = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session?.abortController) {
      return false;
    }
    session.abortController.abort();
    if (session.activeRunId) {
      runIdToSessionId.delete(session.activeRunId);
    }
    session.abortController = null;
    session.activeRunId = null;
    touchSession(session, now());
    return true;
  };

  const deleteSession: AcpSessionStore["deleteSession"] = (sessionId) => removeSession(sessionId);

  const clearAllSessionsForTest: AcpSessionStore["clearAllSessionsForTest"] = () => {
    for (const session of sessions.values()) {
      session.abortController?.abort();
    }
    sessions.clear();
    runIdToSessionId.clear();
  };

  return {
    createSession,
    hasSession,
    getSession,
    getSessionByRunId,
    setActiveRun,
    clearActiveRun,
    cancelActiveRun,
    deleteSession,
    clearAllSessionsForTest,
  };
}

export const defaultAcpSessionStore = createInMemorySessionStore();
