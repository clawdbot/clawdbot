// Prepares ACP reply payloads before TTS, transcript accounting, or delivery.
import { createChannelReplyTransform } from "../../channels/message/reply-transform.js";
import type { ChannelMessagingAdapter } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../types.js";
import { normalizeReplyPayloadOutcome } from "./normalize-reply.js";
import { prepareReplyPayloadForDispatcher } from "./reply-dispatcher.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

export function prepareAcpDeliveryPayload(params: {
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  kind: ReplyDispatchKind;
  payload: ReplyPayload;
  routed: boolean;
  messaging?: ChannelMessagingAdapter;
  accountId?: string;
}) {
  if (!params.routed) {
    return prepareReplyPayloadForDispatcher(params.dispatcher, params.kind, params.payload);
  }
  return normalizeReplyPayloadOutcome(params.payload, {
    transformReplyPayload: createChannelReplyTransform({
      messaging: params.messaging,
      cfg: params.cfg,
      accountId: params.accountId,
    }),
  });
}
