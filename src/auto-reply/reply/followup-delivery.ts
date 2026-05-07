import type { MessagingToolSend } from "../../agents/pi-embedded-messaging.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
} from "./origin-routing.js";
import {
  applyReplyThreading,
  filterMessagingToolDuplicates,
  filterMessagingToolMediaDuplicates,
  resolveMessagingToolPayloadDedupe,
} from "./reply-payloads.js";
import { resolveReplyToMode } from "./reply-threading.js";

function hasReplyPayloadMedia(payload: ReplyPayload): boolean {
  if (typeof payload.mediaUrl === "string" && payload.mediaUrl.trim().length > 0) {
    return true;
  }
  return Array.isArray(payload.mediaUrls) && payload.mediaUrls.some((url) => url.trim().length > 0);
}

export function resolveFollowupDeliveryPayloads(params: {
  cfg: OpenClawConfig;
  payloads: ReplyPayload[];
  messageProvider?: string;
  originatingAccountId?: string;
  originatingChannel?: string;
  originatingChatType?: string | null;
  originatingTo?: string;
  sentMediaUrls?: string[];
  sentTargets?: MessagingToolSend[];
  sentTexts?: string[];
}): ReplyPayload[] {
  const replyMessageProvider = resolveOriginMessageProvider({
    originatingChannel: params.originatingChannel,
    provider: params.messageProvider,
  });
  const replyToChannel = replyMessageProvider as OriginatingChannelType | undefined;
  const replyToMode = resolveReplyToMode(
    params.cfg,
    replyToChannel,
    params.originatingAccountId,
    params.originatingChatType,
  );
  const sanitizedPayloads: ReplyPayload[] = [];
  for (const payload of params.payloads) {
    const text = payload.text;
    if (!text || !text.includes("HEARTBEAT_OK")) {
      sanitizedPayloads.push(payload);
      continue;
    }
    const stripped = stripHeartbeatToken(text, { mode: "message" });
    const hasMedia = hasReplyPayloadMedia(payload);
    if (stripped.shouldSkip && !hasMedia) {
      continue;
    }
    sanitizedPayloads.push({ ...payload, text: stripped.text });
  }
  const replyTaggedPayloads = applyReplyThreading({
    payloads: sanitizedPayloads,
    replyToMode,
    replyToChannel,
  });
  const messagingToolPayloadDedupe = resolveMessagingToolPayloadDedupe({
    messageProvider: replyMessageProvider,
    messagingToolSentTargets: params.sentTargets,
    originatingTo: resolveOriginMessageTo({
      originatingTo: params.originatingTo,
    }),
    accountId: resolveOriginAccountId({
      originatingAccountId: params.originatingAccountId,
    }),
  });
  const sentMediaUrlFallback = params.sentMediaUrls ?? [];
  const sentTextFallback = params.sentTexts ?? [];
  const shouldUseGlobalSentMediaUrlEvidence =
    messagingToolPayloadDedupe.matchingRoute &&
    messagingToolPayloadDedupe.routeSentMediaUrls.length === 0 &&
    messagingToolPayloadDedupe.useGlobalSentMediaUrlEvidenceFallback;
  const shouldUseGlobalSentTextEvidence =
    messagingToolPayloadDedupe.matchingRoute &&
    messagingToolPayloadDedupe.routeSentTexts.length === 0 &&
    messagingToolPayloadDedupe.useGlobalSentTextEvidenceFallback;
  const sentMediaUrlsForDedupe = messagingToolPayloadDedupe.matchingRoute
    ? shouldUseGlobalSentMediaUrlEvidence
      ? sentMediaUrlFallback
      : messagingToolPayloadDedupe.routeSentMediaUrls
    : sentMediaUrlFallback;
  const sentTextsForDedupe = messagingToolPayloadDedupe.matchingRoute
    ? shouldUseGlobalSentTextEvidence
      ? sentTextFallback
      : messagingToolPayloadDedupe.routeSentTexts
    : sentTextFallback;
  const mediaFilteredPayloads = messagingToolPayloadDedupe.shouldDedupePayloads
    ? filterMessagingToolMediaDuplicates({
        payloads: replyTaggedPayloads,
        sentMediaUrls: sentMediaUrlsForDedupe,
      })
    : replyTaggedPayloads;
  const dedupedPayloads = messagingToolPayloadDedupe.shouldDedupePayloads
    ? filterMessagingToolDuplicates({
        payloads: mediaFilteredPayloads,
        sentTexts: sentTextsForDedupe,
      })
    : mediaFilteredPayloads;
  return dedupedPayloads;
}
