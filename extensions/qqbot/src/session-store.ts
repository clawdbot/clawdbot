import fs from "node:fs";
import path from "node:path";
import { debugLog, debugError } from "./utils/debug-log.js";

/** Persisted gateway session state. */
export interface SessionState {
  sessionId: string | null;
  lastSeq: number | null;
  lastConnectedAt: number;
  intentLevelIndex: number;
  accountId: string;
  savedAt: number;
  appId?: string;
}

import { getQQBotDataDir } from "./utils/platform.js";

const SESSION_DIR = getQQBotDataDir("sessions");

const SESSION_EXPIRE_TIME = 5 * 60 * 1000;
const SAVE_THROTTLE_MS = 1000;
const throttleState = new Map<
  string,
  {
    pendingState: SessionState | null;
    lastSaveTime: number;
    throttleTimer: ReturnType<typeof setTimeout> | null;
  }
>();

/** Ensure the session directory exists. */
function ensureDir(): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

function encodeAccountIdForFileName(accountId: string): string {
  return Buffer.from(accountId, "utf8").toString("base64url");
}

function getLegacySessionPath(accountId: string): string {
  const safeId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(SESSION_DIR, `session-${safeId}.json`);
}

/** Return the session file path for one account. */
function getSessionPath(accountId: string): string {
  const encodedId = encodeAccountIdForFileName(accountId);
  return path.join(SESSION_DIR, `session-${encodedId}.json`);
}

function getCandidateSessionPaths(accountId: string): string[] {
  const primaryPath = getSessionPath(accountId);
  const legacyPath = getLegacySessionPath(accountId);
  return primaryPath === legacyPath ? [primaryPath] : [primaryPath, legacyPath];
}

/** Load a saved session, rejecting expired or mismatched appId entries. */
export function loadSession(accountId: string, expectedAppId?: string): SessionState | null {
  try {
    let filePath: string | null = null;
    for (const candidatePath of getCandidateSessionPaths(accountId)) {
      if (fs.existsSync(candidatePath)) {
        filePath = candidatePath;
        break;
      }
    }

    if (!filePath) {
      return null;
    }

    const data = fs.readFileSync(filePath, "utf-8");
    const state = JSON.parse(data) as SessionState;

    const now = Date.now();
    if (now - state.savedAt > SESSION_EXPIRE_TIME) {
      debugLog(
        `[session-store] Session expired for ${accountId}, age: ${Math.round((now - state.savedAt) / 1000)}s`,
      );
      try {
        fs.unlinkSync(filePath);
      } catch {}
      return null;
    }

    if (expectedAppId && state.appId && state.appId !== expectedAppId) {
      debugLog(
        `[session-store] appId mismatch for ${accountId}: saved=${state.appId}, current=${expectedAppId}. Discarding stale session.`,
      );
      try {
        fs.unlinkSync(filePath);
      } catch {}
      return null;
    }

    if (!state.sessionId || state.lastSeq === null || state.lastSeq === undefined) {
      debugLog(`[session-store] Invalid session data for ${accountId}`);
      return null;
    }

    debugLog(
      `[session-store] Loaded session for ${accountId}: sessionId=${state.sessionId}, lastSeq=${state.lastSeq}, appId=${state.appId ?? "unknown"}, age=${Math.round((now - state.savedAt) / 1000)}s`,
    );
    return state;
  } catch (err) {
    debugError(`[session-store] Failed to load session for ${accountId}: ${String(err)}`);
    return null;
  }
}

/** Save session state with throttling. */
export function saveSession(state: SessionState): void {
  const { accountId } = state;

  let throttle = throttleState.get(accountId);
  if (!throttle) {
    throttle = {
      pendingState: null,
      lastSaveTime: 0,
      throttleTimer: null,
    };
    throttleState.set(accountId, throttle);
  }

  const now = Date.now();
  const timeSinceLastSave = now - throttle.lastSaveTime;

  if (timeSinceLastSave >= SAVE_THROTTLE_MS) {
    doSaveSession(state);
    throttle.lastSaveTime = now;
    throttle.pendingState = null;

    if (throttle.throttleTimer) {
      clearTimeout(throttle.throttleTimer);
      throttle.throttleTimer = null;
    }
  } else {
    throttle.pendingState = state;

    if (!throttle.throttleTimer) {
      const delay = SAVE_THROTTLE_MS - timeSinceLastSave;
      throttle.throttleTimer = setTimeout(() => {
        const t = throttleState.get(accountId);
        if (t && t.pendingState) {
          doSaveSession(t.pendingState);
          t.lastSaveTime = Date.now();
          t.pendingState = null;
        }
        if (t) {
          t.throttleTimer = null;
        }
      }, delay);
    }
  }
}

/** Write one session file to disk immediately. */
function doSaveSession(state: SessionState): void {
  const filePath = getSessionPath(state.accountId);
  const legacyPath = getLegacySessionPath(state.accountId);

  try {
    ensureDir();

    const stateToSave: SessionState = {
      ...state,
      savedAt: Date.now(),
    };

    fs.writeFileSync(filePath, JSON.stringify(stateToSave, null, 2), "utf-8");
    if (legacyPath !== filePath && fs.existsSync(legacyPath)) {
      fs.unlinkSync(legacyPath);
    }
    debugLog(
      `[session-store] Saved session for ${state.accountId}: sessionId=${state.sessionId}, lastSeq=${state.lastSeq}`,
    );
  } catch (err) {
    debugError(`[session-store] Failed to save session for ${state.accountId}: ${String(err)}`);
  }
}

/** Clear a saved session and any pending throttle state. */
export function clearSession(accountId: string): void {
  const throttle = throttleState.get(accountId);
  if (throttle) {
    if (throttle.throttleTimer) {
      clearTimeout(throttle.throttleTimer);
    }
    throttleState.delete(accountId);
  }

  try {
    let cleared = false;
    for (const filePath of getCandidateSessionPaths(accountId)) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        cleared = true;
      }
    }
    if (cleared) {
      debugLog(`[session-store] Cleared session for ${accountId}`);
    }
  } catch (err) {
    debugError(`[session-store] Failed to clear session for ${accountId}: ${String(err)}`);
  }
}

/** Update only lastSeq on the persisted session. */
export function updateLastSeq(accountId: string, lastSeq: number): void {
  const existing = loadSession(accountId);
  if (existing && existing.sessionId) {
    saveSession({
      ...existing,
      lastSeq,
    });
  }
}

/** Load all saved sessions from disk. */
export function getAllSessions(): SessionState[] {
  const sessions = new Map<string, SessionState>();

  try {
    ensureDir();
    const files = fs.readdirSync(SESSION_DIR);

    for (const file of files) {
      if (file.startsWith("session-") && file.endsWith(".json")) {
        const filePath = path.join(SESSION_DIR, file);
        try {
          const data = fs.readFileSync(filePath, "utf-8");
          const state = JSON.parse(data) as SessionState;
          if (typeof state.accountId !== "string" || !state.accountId) {
            continue;
          }
          const existing = sessions.get(state.accountId);
          if (!existing || (state.savedAt ?? 0) >= (existing.savedAt ?? 0)) {
            sessions.set(state.accountId, state);
          }
        } catch {
          // Ignore malformed session files here.
        }
      }
    }
  } catch {
    // Ignore missing directories and similar filesystem errors.
  }

  return [...sessions.values()];
}

/**
 * Remove expired session files from disk.
 */
export function cleanupExpiredSessions(): number {
  let cleaned = 0;

  try {
    ensureDir();
    const files = fs.readdirSync(SESSION_DIR);
    const now = Date.now();

    for (const file of files) {
      if (file.startsWith("session-") && file.endsWith(".json")) {
        const filePath = path.join(SESSION_DIR, file);
        try {
          const data = fs.readFileSync(filePath, "utf-8");
          const state = JSON.parse(data) as SessionState;

          if (now - state.savedAt > SESSION_EXPIRE_TIME) {
            fs.unlinkSync(filePath);
            cleaned++;
            debugLog(`[session-store] Cleaned expired session: ${file}`);
          }
        } catch {
          // Remove corrupted session files while ignoring parse errors.
          try {
            fs.unlinkSync(filePath);
            cleaned++;
          } catch {
            // Ignore cleanup failures.
          }
        }
      }
    }
  } catch {
    // Ignore missing directories and similar filesystem errors.
  }

  return cleaned;
}
