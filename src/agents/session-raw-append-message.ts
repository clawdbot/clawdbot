/**
 * Stores and retrieves an unguarded SessionManager appendMessage function.
 * Transcript repair paths use this symbol slot to bypass wrappers without
 * changing the public SessionManager interface.
 */
import type { SessionManager } from "./sessions/index.js";

const RAW_APPEND_MESSAGE = Symbol("openclaw.session.rawAppendMessage");

type SessionManagerWithRawAppend = SessionManager & {
  [RAW_APPEND_MESSAGE]?: SessionManager["appendMessage"];
};

/** Return the unguarded appendMessage implementation for a session manager. */
export function getRawSessionAppendMessage(
  sessionManager: SessionManager,
): SessionManager["appendMessage"] {
  const rawAppend = (sessionManager as SessionManagerWithRawAppend)[RAW_APPEND_MESSAGE];
  return rawAppend ?? sessionManager.appendMessage.bind(sessionManager);
}

/** Stores the unguarded appendMessage implementation on a session manager. */
export function setRawSessionAppendMessage(
  sessionManager: SessionManager,
  appendMessage: SessionManager["appendMessage"],
): void {
  (sessionManager as SessionManagerWithRawAppend)[RAW_APPEND_MESSAGE] = appendMessage;
}
