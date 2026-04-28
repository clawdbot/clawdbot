import {
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  type ChunkMode,
} from "openclaw/plugin-sdk/reply-chunking";
import {
  resolveSendableOutboundReplyParts,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { normalizeOptionalLowercaseString, sleep } from "openclaw/plugin-sdk/text-runtime";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import type { MarkdownTableMode, MSTeamsReplyStyle, OpenClawConfig } from "../runtime-api.js";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import type { StoredConversationReference } from "./conversation-store.js";
import { classifyMSTeamsSendError } from "./errors.js";
import { prepareFileConsentActivity, requiresFileConsent } from "./file-consent-helpers.js";
import { buildTeamsFileInfoCard } from "./graph-chat.js";
import {
  getDriveItemProperties,
  uploadAndShareOneDrive,
  uploadAndShareSharePoint,
} from "./graph-upload.js";
import { extractFilename, extractMessageId, getMimeType, isLocalPath } from "./media-helpers.js";
import { parseMentions } from "./mentions.js";
import { setPendingUploadActivityId } from "./pending-uploads.js";
import { withRevokedProxyFallback } from "./revoked-context.js";
import { getMSTeamsRuntime } from "./runtime.js";

/**
 * MSTeams-specific media size limit (100MB).
 * Higher than the default because OneDrive upload handles large files well.
 */
const MSTEAMS_MAX_MEDIA_BYTES = 100 * 1024 * 1024;

/**
 * Threshold for large files that require FileConsentCard flow in personal chats.
 * Files >= 4MB use consent flow; smaller images can use inline base64.
 */
const FILE_CONSENT_THRESHOLD_BYTES = 4 * 1024 * 1024;

type SendContext = {
  sendActivity: (textOrActivity: string | object) => Promise<unknown>;
  updateActivity: (activity: object) => Promise<{ id?: string } | void>;
  deleteActivity: (activityId: string) => Promise<void>;
};

export type MSTeamsConversationReference = {
  activityId?: string;
  user?: { id?: string; name?: string; aadObjectId?: string };
  agent?: { id?: string; name?: string; aadObjectId?: string } | null;
  conversation: { id: string; conversationType?: string; tenantId?: string };
  channelId: string;
  serviceUrl?: string;
  locale?: string;
  /**
   * Top-level tenant ID echoed onto the Bot Framework connector request. Included
   * alongside `conversation.tenantId` so the connector can route proactive sends
   * to the correct Azure AD tenant. Missing it causes HTTP 403 on proactive
   * (bot-initiated) messages.
   */
  tenantId?: string;
  /**
   * Azure AD object ID of the target user, forwarded on proactive sends so
   * Bot Framework can resolve the personal DM recipient on the connector side.
   */
  aadObjectId?: string;
};

export type MSTeamsAdapter = {
  continueConversation: (
    appId: string,
    reference: MSTeamsConversationReference,
    logic: (context: SendContext) => Promise<void>,
  ) => Promise<void>;
  process: (
    req: unknown,
    res: unknown,
    logic: (context: unknown) => Promise<void>,
  ) => Promise<void>;
  updateActivity: (context: unknown, activity: object) => Promise<void>;
  deleteActivity: (context: unknown, reference: { activityId?: string }) => Promise<void>;
};

export type MSTeamsReplyRenderOptions = {
  textChunkLimit: number;
  chunkText?: boolean;
  mediaMode?: "split" | "inline";
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
};

/**
 * A rendered message that preserves media vs text distinction.
 * When mediaUrl is present, it will be sent as a Bot Framework attachment.
 */
export type MSTeamsRenderedMessage = {
  text?: string;
  mediaUrl?: string;
};

export type MSTeamsSendRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export type MSTeamsSendRetryEvent = {
  messageIndex: number;
  messageCount: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  classification: ReturnType<typeof classifyMSTeamsSendError>;
};

function normalizeConversationId(rawId: string): string {
  return rawId.split(";")[0] ?? rawId;
}

export function buildConversationReference(
  ref: StoredConversationReference,
): MSTeamsConversationReference {
  const conversationId = ref.conversation?.id?.trim();
  if (!conversationId) {
    throw new Error("Invalid stored reference: missing conversation.id");
  }
  const agent = ref.agent ?? ref.bot ?? undefined;
  if (agent == null || !agent.id) {
    throw new Error("Invalid stored reference: missing agent.id");
  }
  const user = ref.user;
  if (!user?.id) {
    throw new Error("Invalid stored reference: missing user.id");
  }
  // Bot Framework proactive sends require `tenantId` on the outbound activity
  // so the connector routes to the correct Azure AD tenant; otherwise it rejects
  // with HTTP 403. Prefer the explicit top-level `ref.tenantId` (captured from
  // `channelData.tenant.id` inbound) and fall back to `conversation.tenantId`.
  const tenantId = ref.tenantId ?? ref.conversation?.tenantId;
  const aadObjectId = ref.aadObjectId ?? user.aadObjectId;
  return {
    activityId: ref.activityId,
    user: aadObjectId ? { ...user, aadObjectId } : user,
    agent,
    conversation: {
      id: normalizeConversationId(conversationId),
      conversationType: ref.conversation?.conversationType,
      tenantId,
    },
    channelId: ref.channelId ?? "msteams",
    serviceUrl: ref.serviceUrl,
    locale: ref.locale,
    ...(tenantId ? { tenantId } : {}),
    ...(aadObjectId ? { aadObjectId } : {}),
  };
}

function pushTextMessages(
  out: MSTeamsRenderedMessage[],
  text: string,
  opts: {
    chunkText: boolean;
    chunkLimit: number;
    chunkMode: ChunkMode;
  },
) {
  if (!text) {
    return;
  }
  if (opts.chunkText) {
    for (const chunk of getMSTeamsRuntime().channel.text.chunkMarkdownTextWithMode(
      text,
      opts.chunkLimit,
      opts.chunkMode,
    )) {
      const trimmed = chunk.trim();
      if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
        continue;
      }
      out.push({ text: trimmed });
    }
    return;
  }

  const trimmed = text.trim();
  if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
    return;
  }
  out.push({ text: trimmed });
}

function clampMs(value: number, maxMs: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(value, maxMs);
}

function resolveRetryOptions(
  retry: false | MSTeamsSendRetryOptions | undefined,
): Required<MSTeamsSendRetryOptions> & { enabled: boolean } {
  if (!retry) {
    return { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 };
  }
  return {
    enabled: true,
    maxAttempts: Math.max(1, retry?.maxAttempts ?? 3),
    baseDelayMs: Math.max(0, retry?.baseDelayMs ?? 250),
    maxDelayMs: Math.max(0, retry?.maxDelayMs ?? 10_000),
  };
}

function computeRetryDelayMs(
  attempt: number,
  classification: ReturnType<typeof classifyMSTeamsSendError>,
  opts: Required<MSTeamsSendRetryOptions>,
): number {
  if (classification.retryAfterMs != null) {
    return clampMs(classification.retryAfterMs, opts.maxDelayMs);
  }
  const exponential = opts.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return clampMs(exponential, opts.maxDelayMs);
}

function shouldRetry(classification: ReturnType<typeof classifyMSTeamsSendError>): boolean {
  return classification.kind === "throttled" || classification.kind === "transient";
}

export function renderReplyPayloadsToMessages(
  replies: ReplyPayload[],
  options: MSTeamsReplyRenderOptions,
): MSTeamsRenderedMessage[] {
  const out: MSTeamsRenderedMessage[] = [];
  const chunkLimit = Math.min(options.textChunkLimit, 4000);
  const chunkText = options.chunkText !== false;
  const chunkMode = options.chunkMode ?? "length";
  const mediaMode = options.mediaMode ?? "split";
  const tableMode =
    options.tableMode ??
    getMSTeamsRuntime().channel.text.resolveMarkdownTableMode({
      cfg: getMSTeamsRuntime().config.current() as OpenClawConfig,
      channel: "msteams",
    });

  for (const payload of replies) {
    const reply = resolveSendableOutboundReplyParts(payload, {
      text: getMSTeamsRuntime().channel.text.convertMarkdownTables(payload.text ?? "", tableMode),
    });

    if (!reply.hasContent) {
      continue;
    }

    if (!reply.hasMedia) {
      pushTextMessages(out, reply.text, { chunkText, chunkLimit, chunkMode });
      continue;
    }

    if (mediaMode === "inline") {
      // For inline mode, combine text with first media as attachment
      const firstMedia = reply.mediaUrls[0];
      if (firstMedia) {
        out.push({ text: reply.text || undefined, mediaUrl: firstMedia });
        // Additional media URLs as separate messages
        for (let i = 1; i < reply.mediaUrls.length; i++) {
          if (reply.mediaUrls[i]) {
            out.push({ mediaUrl: reply.mediaUrls[i] });
          }
        }
      } else {
        pushTextMessages(out, reply.text, { chunkText, chunkLimit, chunkMode });
      }
      continue;
    }

    // mediaMode === "split"
    pushTextMessages(out, reply.text, { chunkText, chunkLimit, chunkMode });
    for (const mediaUrl of reply.mediaUrls) {
      if (!mediaUrl) {
        continue;
      }
      out.push({ mediaUrl });
    }
  }

  return out;
}

import { AI_GENERATED_ENTITY } from "./ai-entity.js";

export async function buildActivity(
  msg: MSTeamsRenderedMessage,
  conversationRef: StoredConversationReference,
  tokenProvider?: MSTeamsAccessTokenProvider,
  sharePointSiteId?: string,
  mediaMaxBytes?: number,
  options?: { feedbackLoopEnabled?: boolean },
): Promise<Record<string, unknown>> {
  const activity: Record<string, unknown> = { type: "message" };

  // Mark as AI-generated so Teams renders the "AI generated" badge.
  activity.channelData = {
    feedbackLoopEnabled: options?.feedbackLoopEnabled ?? false,
  };

  if (msg.text) {
    // Parse mentions from text (format: @[Name](id))
    const { text: formattedText, entities } = parseMentions(msg.text);
    activity.text = formattedText;

    // Start with mention entities (if any) + AI-generated entity
    activity.entities = [...(entities.length > 0 ? entities : []), AI_GENERATED_ENTITY];
  } else {
    activity.entities = [AI_GENERATED_ENTITY];
  }

  if (msg.mediaUrl) {
    let contentUrl = msg.mediaUrl;
    let contentType = await getMimeType(msg.mediaUrl);
    let fileName = await extractFilename(msg.mediaUrl);

    if (isLocalPath(msg.mediaUrl)) {
      const maxBytes = mediaMaxBytes ?? MSTEAMS_MAX_MEDIA_BYTES;
      const media = await loadWebMedia(msg.mediaUrl, maxBytes);
      contentType = media.contentType ?? contentType;
      fileName = media.fileName ?? fileName;

      // Determine conversation type and file type
      // Teams only accepts base64 data URLs for images
      const conversationType = normalizeOptionalLowercaseString(
        conversationRef.conversation?.conversationType,
      );
      const isPersonal = conversationType === "personal";
      const isImage = media.kind === "image";

      if (
        requiresFileConsent({
          conversationType,
          contentType,
          bufferSize: media.buffer.length,
          thresholdBytes: FILE_CONSENT_THRESHOLD_BYTES,
        })
      ) {
        // Large file or non-image in personal chat: use FileConsentCard flow
        const conversationId = conversationRef.conversation?.id ?? "unknown";
        const { activity: consentActivity, uploadId } = prepareFileConsentActivity({
          media: { buffer: media.buffer, filename: fileName, contentType },
          conversationId,
          description: msg.text || undefined,
        });

        // Tag the activity so the caller can store the activity ID after sending
        consentActivity._pendingUploadId = uploadId;

        // Return the consent activity (caller sends it)
        return consentActivity;
      }

      if (!isPersonal && !isImage && tokenProvider && sharePointSiteId) {
        // Non-image in group chat/channel with SharePoint site configured:
        // Upload to SharePoint and use native file card attachment.
        // Use the cached Graph-native chat ID when available — Bot Framework conversation IDs
        // for personal DMs use a format (e.g. `a:1xxx`) that Graph API rejects.
        const chatId = conversationRef.graphChatId ?? conversationRef.conversation?.id;

        // Upload to SharePoint
        const uploaded = await uploadAndShareSharePoint({
          buffer: media.buffer,
          filename: fileName,
          contentType,
          tokenProvider,
          siteId: sharePointSiteId,
          chatId: chatId ?? undefined,
          usePerUserSharing: conversationType === "groupchat",
        });

        // Get driveItem properties needed for native file card attachment
        const driveItem = await getDriveItemProperties({
          siteId: sharePointSiteId,
          itemId: uploaded.itemId,
          tokenProvider,
        });

        // Build native Teams file card attachment
        const fileCardAttachment = buildTeamsFileInfoCard(driveItem);
        activity.attachments = [fileCardAttachment];

        return activity;
      }

      if (!isPersonal && media.kind !== "image" && tokenProvider) {
        // Fallback: no SharePoint site configured, try OneDrive upload
        const uploaded = await uploadAndShareOneDrive({
          buffer: media.buffer,
          filename: fileName,
          contentType,
          tokenProvider,
        });

        // Bot Framework doesn't support "reference" attachment type for sending
        const fileLink = `📎 [${uploaded.name}](${uploaded.shareUrl})`;
        const existingText = typeof activity.text === "string" ? activity.text : undefined;
        activity.text = existingText ? `${existingText}\n\n${fileLink}` : fileLink;
        return activity;
      }

      // Image (any chat): use base64 (works for images in all conversation types)
      const base64 = media.buffer.toString("base64");
      contentUrl = `data:${media.contentType};base64,${base64}`;
    }

    activity.attachments = [
      {
        name: fileName,
        contentType,
        contentUrl,
      },
    ];
  }

  return activity;
}

export async function sendMSTeamsMessages(params: {
  replyStyle: MSTeamsReplyStyle;
  adapter: MSTeamsAdapter;
  appId: string;
  conversationRef: StoredConversationReference;
  context?: SendContext;
  messages: MSTeamsRenderedMessage[];
  retry?: false | MSTeamsSendRetryOptions;
  onRetry?: (event: MSTeamsSendRetryEvent) => void;
  /** Token provider for OneDrive/SharePoint uploads in group chats/channels */
  tokenProvider?: MSTeamsAccessTokenProvider;
  /** SharePoint site ID for file uploads in group chats/channels */
  sharePointSiteId?: string;
  /** Max media size in bytes. Default: 100MB. */
  mediaMaxBytes?: number;
  /** Enable the Teams feedback loop (thumbs up/down) on sent messages. */
  feedbackLoopEnabled?: boolean;
}): Promise<string[]> {
  const messages = params.messages.filter(
    (m) => (m.text && m.text.trim().length > 0) || m.mediaUrl,
  );
  if (messages.length === 0) {
    return [];
  }

  const retryOptions = resolveRetryOptions(params.retry);

  const sendWithRetry = async (
    sendOnce: () => Promise<unknown>,
    meta: { messageIndex: number; messageCount: number },
  ): Promise<unknown> => {
    if (!retryOptions.enabled) {
      return await sendOnce();
    }

    let attempt = 1;
    while (true) {
      try {
        return await sendOnce();
      } catch (err) {
        const classification = classifyMSTeamsSendError(err);
        const canRetry = attempt < retryOptions.maxAttempts && shouldRetry(classification);
        if (!canRetry) {
          throw err;
        }

        const delayMs = computeRetryDelayMs(attempt, classification, retryOptions);
        const nextAttempt = attempt + 1;
        params.onRetry?.({
          messageIndex: meta.messageIndex,
          messageCount: meta.messageCount,
          nextAttempt,
          maxAttempts: retryOptions.maxAttempts,
          delayMs,
          classification,
        });

        await sleep(delayMs);
        attempt = nextAttempt;
      }
    }
  };

  const sendMessageInContext = async (
    ctx: SendContext,
    message: MSTeamsRenderedMessage,
    messageIndex: number,
  ): Promise<string> => {
    let pendingUploadId: string | undefined;
    const response = await sendWithRetry(
      async () => {
        const activity = await buildActivity(
          message,
          params.conversationRef,
          params.tokenProvider,
          params.sharePointSiteId,
          params.mediaMaxBytes,
          { feedbackLoopEnabled: params.feedbackLoopEnabled },
        );

        // Extract and strip the internal-only pending upload tag before sending.
        pendingUploadId =
          typeof activity._pendingUploadId === "string" ? activity._pendingUploadId : undefined;
        if (pendingUploadId) {
          delete activity._pendingUploadId;
        }

        return await ctx.sendActivity(activity);
      },
      {
        messageIndex,
        messageCount: messages.length,
      },
    );
    const messageId = extractMessageId(response) ?? "unknown";

    // Store the activity ID so the accept handler can replace the consent card in-place
    if (pendingUploadId && messageId !== "unknown") {
      setPendingUploadActivityId(pendingUploadId, messageId);
    }

    return messageId;
  };

  const sendMessageBatchInContext = async (
    ctx: SendContext,
    batch: MSTeamsRenderedMessage[],
    startIndex: number,
  ): Promise<string[]> => {
    const messageIds: string[] = [];
    for (const [idx, message] of batch.entries()) {
      messageIds.push(await sendMessageInContext(ctx, message, startIndex + idx));
    }
    return messageIds;
  };

  const sendProactively = async (
    batch: MSTeamsRenderedMessage[],
    startIndex: number,
    threadActivityId?: string,
  ): Promise<string[]> => {
    const baseRef = buildConversationReference(params.conversationRef);
    const isChannel = params.conversationRef.conversation?.conversationType === "channel";
    // For Teams channels, reconstruct the threaded conversation ID so the
    // proactive message lands in the correct thread instead of creating a
    // new top-level post in the channel.
    const conversationId =
      isChannel && threadActivityId
        ? `${baseRef.conversation.id};messageid=${threadActivityId}`
        : baseRef.conversation.id;
    const proactiveRef: MSTeamsConversationReference = {
      ...baseRef,
      activityId: undefined,
      conversation: { ...baseRef.conversation, id: conversationId },
    };

    const messageIds: string[] = [];
    await params.adapter.continueConversation(params.appId, proactiveRef, async (ctx) => {
      messageIds.push(...(await sendMessageBatchInContext(ctx, batch, startIndex)));
    });
    return messageIds;
  };

  // Resolve the thread root message ID for channel thread routing.
  // `threadId` is the canonical thread root (set on inbound for channel threads);
  // fall back to `activityId` for backward compatibility with older stored refs.
  const resolvedThreadId = params.conversationRef.threadId ?? params.conversationRef.activityId;

  if (params.replyStyle === "thread") {
    const ctx = params.context;
    if (!ctx) {
      throw new Error("Missing context for replyStyle=thread");
    }
    const messageIds: string[] = [];
    for (const [idx, message] of messages.entries()) {
      const result = await withRevokedProxyFallback({
        run: async () => ({
          ids: [await sendMessageInContext(ctx, message, idx)],
          fellBack: false,
        }),
        onRevoked: async () => {
          // When the live turn context is revoked (e.g. debounced messages),
          // reconstruct the threaded conversation ID so the proactive
          // fallback delivers the reply into the correct channel thread.
          const remaining = messages.slice(idx);
          return {
            ids:
              remaining.length > 0 ? await sendProactively(remaining, idx, resolvedThreadId) : [],
            fellBack: true,
          };
        },
      });
      messageIds.push(...result.ids);
      if (result.fellBack) {
        return messageIds;
      }
    }
    return messageIds;
  }

  return await sendProactively(messages, 0);
}
