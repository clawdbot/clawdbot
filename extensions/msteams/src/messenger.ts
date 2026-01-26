import {
  type ChunkMode,
  isSilentReplyText,
  loadWebMedia,
  type MarkdownTableMode,
  type MSTeamsReplyStyle,
  type ReplyPayload,
  SILENT_REPLY_TOKEN,
} from "clawdbot/plugin-sdk";
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
};

export type MSTeamsConversationReference = {
  activityId?: string;
  user?: { id?: string; name?: string; aadObjectId?: string };
  agent?: { id?: string; name?: string; aadObjectId?: string } | null;
  conversation: { id: string; conversationType?: string; tenantId?: string };
  channelId: string;
  serviceUrl?: string;
  locale?: string;
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
  return {
    activityId: ref.activityId,
    user,
    agent,
    conversation: {
      id: normalizeConversationId(conversationId),
      conversationType: ref.conversation?.conversationType,
      tenantId: ref.conversation?.tenantId,
    },
    channelId: ref.channelId ?? "msteams",
    serviceUrl: ref.serviceUrl,
    locale: ref.locale,
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
  if (!text) return;
  if (opts.chunkText) {
    for (const chunk of getMSTeamsRuntime().channel.text.chunkMarkdownTextWithMode(
      text,
      opts.chunkLimit,
      opts.chunkMode,
    )) {
      const trimmed = chunk.trim();
      if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) continue;
      out.push({ text: trimmed });
    }
    return;
  }

  const trimmed = text.trim();
  if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) return;
  out.push({ text: trimmed });
}


function clampMs(value: number, maxMs: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, maxMs);
}

async function sleep(ms: number): Promise<void> {
  const delay = Math.max(0, ms);
  if (delay === 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delay);
  });
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
      cfg: getMSTeamsRuntime().config.loadConfig(),
      channel: "msteams",
    });

  for (const payload of replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = getMSTeamsRuntime().channel.text.convertMarkdownTables(
      payload.text ?? "",
      tableMode,
    );

    if (!text && mediaList.length === 0) continue;

    if (mediaList.length === 0) {
      pushTextMessages(out, text, { chunkText, chunkLimit, chunkMode });
      continue;
    }

    if (mediaMode === "inline") {
      // For inline mode, combine text with first media as attachment
      const firstMedia = mediaList[0];
      if (firstMedia) {
        out.push({ text: text || undefined, mediaUrl: firstMedia });
        // Additional media URLs as separate messages
        for (let i = 1; i < mediaList.length; i++) {
          if (mediaList[i]) out.push({ mediaUrl: mediaList[i] });
        }
      } else {
        pushTextMessages(out, text, { chunkText, chunkLimit, chunkMode });
      }
      continue;
    }

    // mediaMode === "split"
    pushTextMessages(out, text, { chunkText, chunkLimit, chunkMode });
    for (const mediaUrl of mediaList) {
      if (!mediaUrl) continue;
      out.push({ mediaUrl });
    }
  }

  return out;
}

async function buildActivity(
  msg: MSTeamsRenderedMessage,
  conversationRef: StoredConversationReference,
  tokenProvider?: MSTeamsAccessTokenProvider,
  sharePointSiteId?: string,
  mediaMaxBytes?: number,
): Promise<Record<string, unknown>> {
  const activity: Record<string, unknown> = { type: "message" };

  if (msg.text) {
    activity.text = msg.text;
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
      const conversationType = conversationRef.conversation?.conversationType?.toLowerCase();
      const isPersonal = conversationType === "personal";
      const isImage = contentType?.startsWith("image/") ?? false;

      if (requiresFileConsent({
        conversationType,
        contentType,
        bufferSize: media.buffer.length,
        thresholdBytes: FILE_CONSENT_THRESHOLD_BYTES,
      })) {
        // Large file or non-image in personal chat: use FileConsentCard flow
        const conversationId = conversationRef.conversation?.id ?? "unknown";
        const { activity: consentActivity } = prepareFileConsentActivity({
          media: { buffer: media.buffer, filename: fileName, contentType },
          conversationId,
          description: msg.text || undefined,
        });

        // Return the consent activity (caller sends it)
        return consentActivity;
      }

      if (!isPersonal && !isImage && tokenProvider && sharePointSiteId) {
        // Non-image in group chat/channel with SharePoint site configured:
        // Upload to SharePoint and use native file card attachment
        const chatId = conversationRef.conversation?.id;

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

      if (!isPersonal && !isImage && tokenProvider) {
        // Fallback: no SharePoint site configured, try OneDrive upload
        const uploaded = await uploadAndShareOneDrive({
          buffer: media.buffer,
          filename: fileName,
          contentType,
          tokenProvider,
        });

        // Bot Framework doesn't support "reference" attachment type for sending
        const fileLink = `📎 [${uploaded.name}](${uploaded.shareUrl})`;
        activity.text = msg.text ? `${msg.text}\n\n${fileLink}` : fileLink;
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
}): Promise<string[]> {
  const messages = params.messages.filter(
    (m) => (m.text && m.text.trim().length > 0) || m.mediaUrl,
  );
  if (messages.length === 0) return [];

  const retryOptions = resolveRetryOptions(params.retry);

  const sendWithRetry = async (
    sendOnce: () => Promise<unknown>,
    meta: { messageIndex: number; messageCount: number },
  ): Promise<unknown> => {
    if (!retryOptions.enabled) return await sendOnce();

    let attempt = 1;
    while (true) {
      try {
        return await sendOnce();
      } catch (err) {
        const classification = classifyMSTeamsSendError(err);
        const canRetry = attempt < retryOptions.maxAttempts && shouldRetry(classification);
        if (!canRetry) throw err;

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

  if (params.replyStyle === "thread") {
    const ctx = params.context;
    if (!ctx) {
      throw new Error("Missing context for replyStyle=thread");
    }
    const messageIds: string[] = [];
    for (const [idx, message] of messages.entries()) {
      const response = await sendWithRetry(
        async () =>
          await ctx.sendActivity(
            await buildActivity(message, params.conversationRef, params.tokenProvider, params.sharePointSiteId, params.mediaMaxBytes),
          ),
        { messageIndex: idx, messageCount: messages.length },
      );
      messageIds.push(extractMessageId(response) ?? "unknown");
    }
    return messageIds;
  }

  const baseRef = buildConversationReference(params.conversationRef);
  const proactiveRef: MSTeamsConversationReference = {
    ...baseRef,
    activityId: undefined,
  };

  const messageIds: string[] = [];
  await params.adapter.continueConversation(params.appId, proactiveRef, async (ctx) => {
    for (const [idx, message] of messages.entries()) {
      const response = await sendWithRetry(
        async () =>
          await ctx.sendActivity(
            await buildActivity(message, params.conversationRef, params.tokenProvider, params.sharePointSiteId, params.mediaMaxBytes),
          ),
        { messageIndex: idx, messageCount: messages.length },
      );
      messageIds.push(extractMessageId(response) ?? "unknown");
    }
  });
  return messageIds;
}
