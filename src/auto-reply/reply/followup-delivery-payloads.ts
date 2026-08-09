import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { MessagingToolSend } from "../../agents/embedded-agent-messaging.types.js";
import type { ReplyToMode } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { copyReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
} from "./origin-routing.js";
import { applyReplyThreading, filterMessagingToolReplyPayload } from "./reply-payloads.js";
import { createReplyDeliveryContext, resolveReplyToMode } from "./reply-threading.js";

/** Strips empty/heartbeat payloads, applies threading, and dedupes message-tool sends. */
export function resolveFollowupDeliveryPayloads(params: {
  cfg: OpenClawConfig;
  payloads: ReplyPayload[];
  messageProvider?: string;
  originatingAccountId?: string;
  originatingChannel?: string;
  originatingChatType?: string | null;
  originatingReplyToMode?: ReplyToMode;
  originatingTo?: string;
  originatingThreadId?: string | number;
  reasoningPayloadsEnabled?: boolean;
  commentaryPayloadsEnabled?: boolean;
  sentMediaUrls?: string[];
  sentTargets?: MessagingToolSend[];
  sentTexts?: string[];
}): ReplyPayload[] {
  const replyMessageProvider = resolveOriginMessageProvider({
    originatingChannel: params.originatingChannel,
    provider: params.messageProvider,
  });
  const replyToChannel = replyMessageProvider as OriginatingChannelType | undefined;
  const replyToMode =
    params.originatingReplyToMode ??
    resolveReplyToMode(
      params.cfg,
      replyToChannel,
      params.originatingAccountId,
      params.originatingChatType,
    );
  const accountId = resolveOriginAccountId({
    originatingAccountId: params.originatingAccountId,
  });
  const replyDelivery = createReplyDeliveryContext(replyToMode, params.originatingChatType);
  const replyDeliverySource = replyMessageProvider
    ? {
        channel: replyMessageProvider,
        ...(accountId ? { accountId } : {}),
      }
    : undefined;
  const deliverablePayloads = params.payloads.filter(
    (payload) =>
      !(payload.isReasoning === true && params.reasoningPayloadsEnabled !== true) &&
      !(payload.isCommentary === true && params.commentaryPayloadsEnabled !== true),
  );
  const sanitizedPayloads: ReplyPayload[] = [];
  for (const payload of deliverablePayloads) {
    const text = payload.text;
    const sanitized =
      text?.includes("HEARTBEAT_OK") === true
        ? copyReplyPayloadMetadata(payload, {
            ...payload,
            text: stripHeartbeatToken(text, { mode: "message" }).text,
          })
        : payload;
    // Normalize before callers decide whether the run was empty. Otherwise a
    // whitespace-only model payload can suppress the interactive fallback.
    if (hasOutboundReplyContent(sanitized, { trimText: true })) {
      sanitizedPayloads.push(sanitized);
    }
  }
  const replyTaggedPayloads = applyReplyThreading({
    payloads: sanitizedPayloads,
    replyToMode,
    replyToChannel,
  }).map((payload) =>
    setReplyPayloadMetadata(payload, {
      replyDelivery,
      ...(replyDeliverySource ? { replyDeliverySource } : {}),
    }),
  );
  const originatingTo = resolveOriginMessageTo({
    originatingTo: params.originatingTo,
  });
  return replyTaggedPayloads.flatMap((payload) =>
    filterMessagingToolReplyPayload({
      payload,
      config: params.cfg,
      messageProvider: replyMessageProvider,
      messagingToolSentTargets: params.sentTargets,
      originatingTo,
      originatingThreadId: params.originatingThreadId,
      accountId,
      sentMediaUrls: params.sentMediaUrls,
      sentTexts: params.sentTexts,
    }),
  );
}
