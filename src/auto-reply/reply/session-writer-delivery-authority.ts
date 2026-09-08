import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { logVerbose } from "../../globals.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import {
  getReplyPayloadMetadata,
  type ReplyPayload,
  type SessionWriterDeliveryAuthority,
} from "../reply-payload.js";

class SessionWriterDeliveryRevokedError extends PlatformMessageNotDispatchedError {
  constructor() {
    super("Session writer changed before final reply delivery", {
      cause: undefined,
      retryable: false,
    });
    this.name = "SessionWriterDeliveryRevokedError";
  }
}

function isAuthorityCurrent(
  authority: SessionWriterDeliveryAuthority,
  fallbackStorePath?: string,
): boolean {
  const storePath = authority.storePath ?? fallbackStorePath;
  const current = storePath
    ? loadSessionEntryReadOnly({
        ...(authority.agentId ? { agentId: authority.agentId } : {}),
        readConsistency: "latest",
        sessionKey: authority.sessionKey,
        storePath,
      })
    : undefined;
  return Boolean(
    current &&
    current.sessionId === authority.expectedSessionId &&
    (authority.expectedLifecycleRevision === undefined ||
      current.lifecycleRevision === authority.expectedLifecycleRevision) &&
    (authority.expectedWriterRunId === undefined ||
      current.activeWriterRunId === authority.expectedWriterRunId),
  );
}

/** Revalidates a settled final payload against the latest committed session writer. */
export function isDispatchFinalReplySessionWriterAuthorized(
  payload: ReplyPayload,
  fallbackStorePath?: string,
  fallbackSessionKey?: string,
): boolean {
  const authority = getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority;
  if (!authority) {
    return true;
  }
  const authorized = isAuthorityCurrent(authority, fallbackStorePath);
  if (!authorized) {
    logVerbose(
      `final reply skipped after session writer replacement (session=${fallbackSessionKey ?? authority.sessionKey})`,
    );
  }
  return authorized;
}

/** Fails closed at the provider's last pre-I/O boundary when writer ownership changed. */
export function assertSessionWriterDeliveryAuthorized(
  authority: SessionWriterDeliveryAuthority | undefined,
  fallbackStorePath?: string,
): void {
  if (authority && !isAuthorityCurrent(authority, fallbackStorePath)) {
    throw new SessionWriterDeliveryRevokedError();
  }
}

/** Fails closed at the provider's last pre-I/O boundary for an authority-bearing payload. */
export function assertReplyPayloadSessionWriterDeliveryAuthorized(
  payload: ReplyPayload,
  fallbackStorePath?: string,
): void {
  const authority = getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority;
  assertSessionWriterDeliveryAuthorized(authority, fallbackStorePath);
}
