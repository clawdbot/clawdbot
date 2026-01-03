/**
 * ACP-GW Session Manager
 *
 * Manages local session metadata. Actual conversation state lives in Gateway.
 * Optionally persists sessions to disk for resume after restart.
 */

import fs from "node:fs";
import path from "node:path";
import type { AcpGwSession, PersistedSession } from "./types.js";

/**
 * In-memory session store.
 */
const sessions = new Map<string, AcpGwSession>();

/**
 * Reverse lookup: runId -> sessionId
 */
const runIdToSessionId = new Map<string, string>();

/**
 * Path to session store file (if persistence enabled).
 */
let storePath: string | null = null;

/**
 * Initialize session persistence.
 */
export function initSessionStore(sessionStorePath?: string): void {
  if (!sessionStorePath) return;
  
  storePath = sessionStorePath;
  
  // Ensure directory exists
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  // Load existing sessions (clears any in-memory sessions first)
  sessions.clear();
  runIdToSessionId.clear();
  
  if (fs.existsSync(storePath)) {
    try {
      const data = fs.readFileSync(storePath, "utf8");
      const persisted = JSON.parse(data) as PersistedSession[];
      for (const p of persisted) {
        const session: AcpGwSession = {
          ...p,
          abortController: null,
          activeRunId: null,
        };
        sessions.set(p.sessionId, session);
      }
    } catch {
      // Ignore parse errors, start fresh
    }
  }
}

/**
 * Save sessions to disk.
 */
function saveSessionStore(): void {
  if (!storePath) return;
  
  const persisted: PersistedSession[] = [];
  for (const session of sessions.values()) {
    persisted.push({
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      cwd: session.cwd,
      createdAt: session.createdAt,
    });
  }
  
  try {
    fs.writeFileSync(storePath, JSON.stringify(persisted, null, 2));
  } catch {
    // Ignore write errors
  }
}

/**
 * Create a new session with a unique ID.
 */
export function createSession(cwd: string): AcpGwSession {
  const sessionId = crypto.randomUUID();
  const session: AcpGwSession = {
    sessionId,
    sessionKey: `acp:${sessionId}`,  // Use acp: prefix for session isolation
    cwd,
    createdAt: Date.now(),
    abortController: null,
    activeRunId: null,
  };
  sessions.set(sessionId, session);
  saveSessionStore();
  return session;
}

/**
 * Get a session by ID.
 */
export function getSession(sessionId: string): AcpGwSession | undefined {
  return sessions.get(sessionId);
}

/**
 * Get all sessions.
 */
export function getAllSessions(): AcpGwSession[] {
  return Array.from(sessions.values());
}

/**
 * Delete a session.
 */
export function deleteSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (session) {
    session.abortController?.abort();
    sessions.delete(sessionId);
    saveSessionStore();
    return true;
  }
  return false;
}

/**
 * Set the active run for a session.
 */
export function setActiveRun(
  sessionId: string,
  runId: string,
  abortController: AbortController,
): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.activeRunId = runId;
    session.abortController = abortController;
    runIdToSessionId.set(runId, sessionId);
  }
}

/**
 * Find session by runId.
 */
export function getSessionByRunId(runId: string): AcpGwSession | undefined {
  const sessionId = runIdToSessionId.get(runId);
  return sessionId ? sessions.get(sessionId) : undefined;
}

/**
 * Clear the active run for a session.
 */
export function clearActiveRun(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    if (session.activeRunId) {
      runIdToSessionId.delete(session.activeRunId);
    }
    session.activeRunId = null;
    session.abortController = null;
  }
}

/**
 * Cancel the active run for a session.
 */
export function cancelActiveRun(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (session?.abortController) {
    session.abortController.abort();
    session.abortController = null;
    session.activeRunId = null;
    return true;
  }
  return false;
}

/**
 * Clear all sessions (for testing).
 */
export function clearAllSessions(): void {
  for (const session of sessions.values()) {
    session.abortController?.abort();
  }
  sessions.clear();
  runIdToSessionId.clear();
  if (storePath && fs.existsSync(storePath)) {
    fs.unlinkSync(storePath);
  }
}
