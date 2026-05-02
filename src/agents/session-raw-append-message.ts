import type { SessionManager } from "@mariozechner/pi-coding-agent";

const RAW_APPEND_MESSAGE = Symbol("openclaw.session.rawAppendMessage");

type SessionManagerWithRawAppend = SessionManager & {
  [RAW_APPEND_MESSAGE]?: SessionManager["appendMessage"];
};

/**
 * Return the unguarded appendMessage implementation for a session manager.
 */
export function getRawSessionAppendMessage(
  sessionManager: SessionManager,
): SessionManager["appendMessage"] {
  const rawAppend = (sessionManager as SessionManagerWithRawAppend)[RAW_APPEND_MESSAGE];
  return rawAppend ?? sessionManager.appendMessage.bind(sessionManager);
}

export function setRawSessionAppendMessage(
  sessionManager: SessionManager,
  appendMessage: SessionManager["appendMessage"],
): void {
  (sessionManager as SessionManagerWithRawAppend)[RAW_APPEND_MESSAGE] = appendMessage;
}
