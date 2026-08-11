import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import { getAttachedBackend } from "../../auto-reply/reply/reply-run-registry.state.js";
import { ACTIVE_EMBEDDED_RUNS, ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY } from "./run-state.js";

/** Resolves the exact run whose terminal lifecycle event belongs to this active session. */
export function resolveActiveEmbeddedRunId(sessionKey: string): string | undefined {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return undefined;
  }
  const replyOperation = replyRunRegistry.get(normalizedSessionKey);
  const replyRunId = replyOperation ? getAttachedBackend(replyOperation)?.runId?.trim() : undefined;
  if (replyRunId) {
    return replyRunId;
  }
  const sessionId = ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey);
  return sessionId ? ACTIVE_EMBEDDED_RUNS.get(sessionId)?.runId?.trim() || undefined : undefined;
}
