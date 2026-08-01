// Msteams plugin module assembles stable inbound activity facts.
import { serializeMSTeamsAdaptiveCardActionValue } from "../adaptive-card-submit.js";
import {
  resolveMSTeamsAdvertisedMedia,
  summarizeMSTeamsHtmlAttachments,
  type MSTeamsAttachmentLike,
} from "../attachments.js";
import { extractHtmlFromAttachment } from "../attachments/shared.js";
import { tryNormalizeBotFrameworkServiceUrl } from "../bot-framework-service-url.js";
import type { StoredConversationReference } from "../conversation-store.js";
import {
  extractMSTeamsConversationMessageId,
  extractMSTeamsQuoteInfo,
  normalizeMSTeamsConversationId,
  stripMSTeamsMentionTags,
  wasMSTeamsBotMentioned,
} from "../inbound.js";
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { wasMSTeamsMessageSentWithPersistence } from "../sent-message-cache.js";

function extractTextFromHtmlAttachments(attachments: MSTeamsAttachmentLike[]): string {
  for (const attachment of attachments) {
    const raw = extractHtmlFromAttachment(attachment);
    if (!raw) {
      continue;
    }
    const text = raw
      .replace(/<at[^>]*>.*?<\/at>/gis, " ")
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis, "$2 $1")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export type MSTeamsDebounceEntry = {
  context: MSTeamsTurnContext;
  rawText: string;
  text: string;
  attachments: MSTeamsAttachmentLike[];
  wasMentioned: boolean;
  implicitMentionKinds: Array<"reply_to_bot">;
  turnAdoptionLifecycle?: MSTeamsIngressLifecycle;
};

export async function prepareMSTeamsDebounceEntry(params: {
  context: MSTeamsTurnContext;
  turnAdoptionLifecycle?: MSTeamsIngressLifecycle;
}): Promise<MSTeamsDebounceEntry> {
  const activity = params.context.activity;
  const attachments = Array.isArray(activity.attachments)
    ? (activity.attachments as unknown as MSTeamsAttachmentLike[])
    : [];
  const rawText = activity.text?.trim() ?? "";
  const htmlText = extractTextFromHtmlAttachments(attachments);
  const valueText =
    rawText || htmlText ? "" : serializeMSTeamsAdaptiveCardActionValue(activity.value);
  const text = stripMSTeamsMentionTags(rawText || htmlText || valueText || "");
  const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
  const replyToId = activity.replyToId ?? undefined;
  const implicitMentionKinds: Array<"reply_to_bot"> =
    conversationId &&
    replyToId &&
    (await wasMSTeamsMessageSentWithPersistence({ conversationId, messageId: replyToId }))
      ? ["reply_to_bot"]
      : [];

  return {
    context: params.context,
    rawText,
    text,
    attachments,
    wasMentioned: wasMSTeamsBotMentioned(activity),
    implicitMentionKinds,
    turnAdoptionLifecycle: params.turnAdoptionLifecycle,
  };
}

function buildStoredConversationReference(params: {
  activity: MSTeamsTurnContext["activity"];
  conversationId: string;
  conversationType: string;
  teamId?: string;
  threadId?: string;
}): StoredConversationReference {
  const { activity, conversationId, conversationType, teamId, threadId } = params;
  const from = activity.from;
  const conversation = activity.conversation;
  const clientInfo = activity.entities?.find((entity) => entity.type === "clientInfo") as
    | { timezone?: string }
    | undefined;
  // Proactive sends require the tenant and normalized regional service URL
  // captured from the original Bot Framework activity.
  const tenantId = activity.channelData?.tenant?.id ?? conversation?.tenantId;
  const aadObjectId = from?.aadObjectId;
  const serviceUrl = tryNormalizeBotFrameworkServiceUrl(activity.serviceUrl);
  return {
    activityId: activity.id,
    user: from ? { id: from.id, name: from.name, aadObjectId: from.aadObjectId } : undefined,
    agent: activity.recipient,
    conversation: {
      id: conversationId,
      conversationType,
      tenantId,
    },
    ...(tenantId ? { tenantId } : {}),
    ...(aadObjectId ? { aadObjectId } : {}),
    teamId,
    channelId: activity.channelId,
    ...(serviceUrl ? { serviceUrl } : {}),
    locale: activity.locale,
    ...(clientInfo?.timezone ? { timezone: clientInfo.timezone } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

export function assembleMSTeamsInboundFacts(params: {
  entry: MSTeamsDebounceEntry;
  mediaMaxBytes: number;
}) {
  const { entry, mediaMaxBytes } = params;
  const activity = entry.context.activity;
  const conversation = activity.conversation;
  const rawConversationId = conversation?.id ?? "";
  const conversationId = normalizeMSTeamsConversationId(rawConversationId);
  const conversationMessageId = extractMSTeamsConversationMessageId(rawConversationId);
  const conversationType = conversation?.conversationType ?? "personal";
  const isChannel = conversationType === "channel";
  const teamId = activity.channelData?.team?.id;
  const threadId = isChannel
    ? (conversationMessageId ?? activity.replyToId ?? undefined)
    : undefined;
  const advertisedMedia = resolveMSTeamsAdvertisedMedia(entry.attachments, {
    maxInlineBytes: mediaMaxBytes,
    maxInlineTotalBytes: mediaMaxBytes,
  });

  return {
    ...entry,
    activity,
    from: activity.from,
    conversation,
    rawBody: entry.text,
    advertisedMedia,
    quoteInfo: extractMSTeamsQuoteInfo(entry.attachments),
    attachmentTypes: entry.attachments
      .map((attachment) =>
        typeof attachment.contentType === "string" ? attachment.contentType : undefined,
      )
      .filter(Boolean)
      .slice(0, 3),
    htmlSummary: summarizeMSTeamsHtmlAttachments(entry.attachments),
    rawConversationId,
    conversationId,
    conversationMessageId,
    conversationType,
    isChannel,
    teamId,
    graphChannelId: activity.channelData?.channel?.id?.trim() || conversationId,
    threadId,
    conversationRef: buildStoredConversationReference({
      activity,
      conversationId,
      conversationType,
      teamId,
      threadId,
    }),
  };
}
