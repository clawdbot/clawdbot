import {
  getReplyPayloadMetadata,
  isReplyPayloadSessionWriterDeliveryAuthorized,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { loadSessionEntry } from "../session-utils.js";

export function isChatSendReplyDeliveryAuthorized(params: {
  agentId?: string;
  payload: ReplyPayload;
  sessionLoadOptions: Parameters<typeof loadSessionEntry>[1];
}): boolean {
  const authority = getReplyPayloadMetadata(params.payload)?.sessionWriterDeliveryAuthority;
  if (!authority) {
    return true;
  }
  const current = loadSessionEntry(authority.sessionKey, {
    ...params.sessionLoadOptions,
    ...(authority.agentId || params.agentId
      ? { agentId: authority.agentId ?? params.agentId }
      : {}),
  }).entry;
  return isReplyPayloadSessionWriterDeliveryAuthorized(params.payload, current);
}
