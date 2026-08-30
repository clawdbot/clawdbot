import { logVerbose } from "../../globals.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadSessionWriterDeliveryAuthorized,
  type ReplyPayload,
} from "../reply-payload.js";
import { loadSessionStoreEntry } from "./dispatch-from-config.runtime.js";

/** Revalidates a settled final payload immediately before an outbound delivery boundary. */
export function isDispatchFinalReplySessionWriterAuthorized(
  payload: ReplyPayload,
  fallbackStorePath: string | undefined,
  fallbackSessionKey: string | undefined,
): boolean {
  const authority = getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority;
  if (!authority) {
    return true;
  }
  const storePath = authority.storePath ?? fallbackStorePath;
  const current = storePath
    ? loadSessionStoreEntry({
        ...(authority.agentId ? { agentId: authority.agentId } : {}),
        readConsistency: "latest",
        sessionKey: authority.sessionKey,
        storePath,
      })
    : undefined;
  const authorized = isReplyPayloadSessionWriterDeliveryAuthorized(payload, current);
  if (!authorized) {
    logVerbose(
      `dispatch-from-config: final reply skipped after session writer replacement (session=${fallbackSessionKey ?? "unknown"})`,
    );
  }
  return authorized;
}
