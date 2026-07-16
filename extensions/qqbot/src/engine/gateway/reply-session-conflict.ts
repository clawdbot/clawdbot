// Shared detection and error-ID helpers for reply-session-init conflicts.
// ReplySessionInitConflictError is not exported through the plugin SDK,
// so every channel that needs to surface it must match the message pattern.

const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /^reply session initialization conflicted for \S+$/u;

/** True when `error` matches the shared core's `ReplySessionInitConflictError`. */
export function isReplySessionInitConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(message);
}

/** Short hex reference number for correlating logs with user-visible notices. */
export function generateSessionConflictErrorId(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!.toString(16).padStart(8, "0");
}
