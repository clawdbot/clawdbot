import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-runtime";
import { loadOutboundMediaFromUrl, type OpenClawConfig } from "../runtime-api.js";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
} from "./errors.js";
import { prepareFileConsentActivityFs, requiresFileConsent } from "./file-consent-helpers.js";
import { buildTeamsFileInfoCard } from "./graph-chat.js";
import {
  getDriveItemProperties,
  uploadAndShareOneDrive,
  uploadAndShareSharePoint,
} from "./graph-upload.js";
import { extractFilename, extractMessageId } from "./media-helpers.js";
import { buildConversationReference, sendMSTeamsMessages } from "./messenger.js";
import { setPendingUploadActivityIdFs } from "./pending-uploads-fs.js";
import { setPendingUploadActivityId } from "./pending-uploads.js";
import { buildMSTeamsPollCard } from "./polls.js";
import { resolveMSTeamsSendContext, type MSTeamsProactiveContext } from "./send-context.js";

export type SendMSTeamsMessageParams = {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID or user ID to send to */
  to: string;
  /** Message text */
  text: string;
  /** Optional media URL */
  mediaUrl?: string;
  /** Optional filename override for uploaded media/files */
  filename?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};

export type SendMSTeamsMessageResult = {
  messageId: string;
  conversationId: string;
  /** If a FileConsentCard was sent instead of the file, this contains the upload ID */
  pendingUploadId?: string;
};

/** Threshold for large files that require FileConsentCard flow in personal chats */
const FILE_CONSENT_THRESHOLD_BYTES = 4 * 1024 * 1024; // 4MB

/**
 * MSTeams-specific media size limit (100MB).
 * Higher than the default because OneDrive upload handles large files well.
 */
const MSTEAMS_MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export type SendMSTeamsPollParams = {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID or user ID to send to */
  to: string;
  /** Poll question */
  question: string;
  /** Poll options */
  options: string[];
  /** Max selections (defaults to 1) */
  maxSelections?: number;
};

export type SendMSTeamsPollResult = {
  pollId: string;
  messageId: string;
  conversationId: string;
};

export type SendMSTeamsCardParams = {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID or user ID to send to */
  to: string;
  /** Adaptive Card JSON object */
  card: Record<string, unknown>;
};

export type SendMSTeamsCardResult = {
  messageId: string;
  conversationId: string;
};

/**
 * Send a message to a Teams conversation or user.
 *
 * Uses the stored ConversationReference from previous interactions.
 * The bot must have received at least one message from the conversation
 * before proactive messaging works.
 *
 * File handling by conversation type:
 * - Personal (1:1) chats: small images (<4MB) use base64, large files and non-images use FileConsentCard
 * - Group chats / channels: files are uploaded to OneDrive and shared via link
 */
export async function sendMessageMSTeams(
  params: SendMSTeamsMessageParams,
): Promise<SendMSTeamsMessageResult> {
  const { cfg, to, text, mediaUrl, filename, mediaLocalRoots, mediaReadFile } = params;
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "msteams",
  });
  const messageText = convertMarkdownTables(text ?? "", tableMode);
  const ctx = await resolveMSTeamsSendContext({ cfg, to });
  const {
    adapter,
    appId,
    conversationId,
    ref,
    log,
    conversationType,
    tokenProvider,
    sharePointSiteId,
  } = ctx;

  log.debug?.("sending proactive message", {
    conversationId,
    conversationType,
    textLength: messageText.length,
    hasMedia: Boolean(mediaUrl),
  });

  // Handle media if present
  if (mediaUrl) {
    const mediaMaxBytes = ctx.mediaMaxBytes ?? MSTEAMS_MAX_MEDIA_BYTES;
    const media = await loadOutboundMediaFromUrl(mediaUrl, {
      maxBytes: mediaMaxBytes,
      mediaLocalRoots,
      mediaReadFile,
    });
    const isLargeFile = media.buffer.length >= FILE_CONSENT_THRESHOLD_BYTES;
    const isImage = media.contentType?.startsWith("image/") ?? false;
    const fallbackFileName = await extractFilename(mediaUrl);
    const fileName = filename?.trim() || media.fileName || fallbackFileName;

    log.debug?.("processing media", {
      fileName,
      contentType: media.contentType,
      size: media.buffer.length,
      isLargeFile,
      isImage,
      conversationType,
    });

    // Personal chats: base64 only works for images; use FileConsentCard for large files or non-images
    if (
      requiresFileConsent({
        conversationType,
        contentType: media.contentType,
        bufferSize: media.buffer.length,
        thresholdBytes: FILE_CONSENT_THRESHOLD_BYTES,
      })
    ) {
      // Proactive CLI sends run in a different process from the gateway's
      // monitor that receives the fileConsent/invoke callback. Use the FS-
      // backed helper so the invoke handler can find the pending upload when
      // the user clicks "Allow".
      const { activity, uploadId } = await prepareFileConsentActivityFs({
        media: { buffer: media.buffer, filename: fileName, contentType: media.contentType },
        conversationId,
        description: messageText || undefined,
      });

      log.debug?.("sending file consent card", { uploadId, fileName, size: media.buffer.length });

      const messageId = await sendProactiveActivity({
        adapter,
        appId,
        ref,
        activity,
        errorPrefix: "msteams consent card send",
      });

      // Store the activity ID so the accept handler can replace the consent
      // card in-place. Mirror it into the FS store too because the invoke
      // callback may be delivered to a different process than the CLI send.
      setPendingUploadActivityId(uploadId, messageId);
      await setPendingUploadActivityIdFs(uploadId, messageId);

      log.info("sent file consent card", { conversationId, messageId, uploadId });

      return {
        messageId,
        conversationId,
        pendingUploadId: uploadId,
      };
    }

    // Personal chat with small image: use base64 (only works for images)
    if (conversationType === "personal") {
      // Small image in personal chat: use base64 (only works for images)
      const base64 = media.buffer.toString("base64");
      const finalMediaUrl = `data:${media.contentType};base64,${base64}`;

      return sendTextWithMedia(ctx, messageText, finalMediaUrl);
    }

    if (isImage && !sharePointSiteId) {
      // Group chat/channel without SharePoint: send image inline (avoids OneDrive failures)
      const base64 = media.buffer.toString("base64");
      const finalMediaUrl = `data:${media.contentType};base64,${base64}`;
      return sendTextWithMedia(ctx, messageText, finalMediaUrl);
    }

    // Group chat or channel: upload to SharePoint (if siteId configured) or OneDrive
    try {
      if (sharePointSiteId) {
        // Use SharePoint upload + Graph API for native file card
        log.debug?.("uploading to SharePoint for native file card", {
          fileName,
          conversationType,
          siteId: sharePointSiteId,
        });

        const uploaded = await uploadAndShareSharePoint({
          buffer: media.buffer,
          filename: fileName,
          contentType: media.contentType,
          tokenProvider,
          siteId: sharePointSiteId,
          // Use the Graph-native chat ID (19:xxx format) — the Bot Framework conversationId
          // for personal DMs uses a different format that Graph API rejects.
          chatId: ctx.graphChatId ?? conversationId,
          usePerUserSharing: conversationType === "groupChat",
        });

        log.debug?.("SharePoint upload complete", {
          itemId: uploaded.itemId,
          shareUrl: uploaded.shareUrl,
        });

        // Get driveItem properties needed for native file card
        const driveItem = await getDriveItemProperties({
          siteId: sharePointSiteId,
          itemId: uploaded.itemId,
          tokenProvider,
        });

        log.debug?.("driveItem properties retrieved", {
          eTag: driveItem.eTag,
          webDavUrl: driveItem.webDavUrl,
        });

        // Build native Teams file card attachment and send via Bot Framework
        const fileCardAttachment = buildTeamsFileInfoCard(driveItem);
        const activity = {
          type: "message",
          text: messageText || undefined,
          attachments: [fileCardAttachment],
        };
        const messageId = await sendProactiveActivityRaw({
          adapter,
          appId,
          ref,
          activity,
        });

        log.info("sent native file card", {
          conversationId,
          messageId,
          fileName: driveItem.name,
        });

        return { messageId, conversationId };
      }

      // Fallback: no SharePoint site configured, use OneDrive with markdown link
      log.debug?.("uploading to OneDrive (no SharePoint site configured)", {
        fileName,
        conversationType,
      });

      const uploaded = await uploadAndShareOneDrive({
        buffer: media.buffer,
        filename: fileName,
        contentType: media.contentType,
        tokenProvider,
      });

      log.debug?.("OneDrive upload complete", {
        itemId: uploaded.itemId,
        shareUrl: uploaded.shareUrl,
      });

      // Send message with file link (Bot Framework doesn't support "reference" attachment type for sending)
      const fileLink = `📎 [${uploaded.name}](${uploaded.shareUrl})`;
      const activity = {
        type: "message",
        text: messageText ? `${messageText}\n\n${fileLink}` : fileLink,
      };
      const messageId = await sendProactiveActivityRaw({
        adapter,
        appId,
        ref,
        activity,
      });

      log.info("sent message with OneDrive file link", {
        conversationId,
        messageId,
        shareUrl: uploaded.shareUrl,
      });

      return { messageId, conversationId };
    } catch (err) {
      const classification = classifyMSTeamsSendError(err);
      const hint = formatMSTeamsSendErrorHint(classification);
      const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
      throw new Error(
        `msteams file send failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`,
        { cause: err },
      );
    }
  }

  // No media: send text only
  return sendTextWithMedia(ctx, messageText, undefined);
}

/**
 * Send a text message with optional base64 media URL.
 */
async function sendTextWithMedia(
  ctx: MSTeamsProactiveContext,
  text: string,
  mediaUrl: string | undefined,
): Promise<SendMSTeamsMessageResult> {
  const {
    adapter,
    appId,
    conversationId,
    ref,
    log,
    tokenProvider,
    sharePointSiteId,
    mediaMaxBytes,
  } = ctx;

  let messageIds: string[];
  try {
    messageIds = await sendMSTeamsMessages({
      replyStyle: "top-level",
      adapter,
      appId,
      conversationRef: ref,
      messages: [{ text: text || undefined, mediaUrl }],
      retry: {},
      onRetry: (event) => {
        log.debug?.("retrying send", { conversationId, ...event });
      },
      tokenProvider,
      sharePointSiteId,
      mediaMaxBytes,
    });
  } catch (err) {
    const classification = classifyMSTeamsSendError(err);
    const hint = formatMSTeamsSendErrorHint(classification);
    const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
    throw new Error(
      `msteams send failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`,
      { cause: err },
    );
  }

  const messageId = messageIds[0] ?? "unknown";
  log.info("sent proactive message", { conversationId, messageId });

  return {
    messageId,
    conversationId,
  };
}

type ProactiveActivityParams = {
  adapter: MSTeamsProactiveContext["adapter"];
  appId: string;
  ref: MSTeamsProactiveContext["ref"];
  activity: Record<string, unknown>;
  errorPrefix: string;
};

type ProactiveActivityRawParams = Omit<ProactiveActivityParams, "errorPrefix">;

async function sendProactiveActivityRaw({
  adapter,
  appId,
  ref,
  activity,
}: ProactiveActivityRawParams): Promise<string> {
  const baseRef = buildConversationReference(ref);
  const proactiveRef = {
    ...baseRef,
    activityId: undefined,
  };

  let messageId = "unknown";
  await adapter.continueConversation(appId, proactiveRef, async (ctx) => {
    const response = await ctx.sendActivity(activity);
    messageId = extractMessageId(response) ?? "unknown";
  });
  return messageId;
}

async function sendProactiveActivity({
  adapter,
  appId,
  ref,
  activity,
  errorPrefix,
}: ProactiveActivityParams): Promise<string> {
  try {
    return await sendProactiveActivityRaw({
      adapter,
      appId,
      ref,
      activity,
    });
  } catch (err) {
    const classification = classifyMSTeamsSendError(err);
    const hint = formatMSTeamsSendErrorHint(classification);
    const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
    throw new Error(
      `${errorPrefix} failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`,
      { cause: err },
    );
  }
}

/**
 * Send a poll (Adaptive Card) to a Teams conversation or user.
 */
export async function sendPollMSTeams(
  params: SendMSTeamsPollParams,
): Promise<SendMSTeamsPollResult> {
  const { cfg, to, question, options, maxSelections } = params;
  const { adapter, appId, conversationId, ref, log } = await resolveMSTeamsSendContext({
    cfg,
    to,
  });

  const pollCard = buildMSTeamsPollCard({
    question,
    options,
    maxSelections,
  });

  log.debug?.("sending poll", {
    conversationId,
    pollId: pollCard.pollId,
    optionCount: pollCard.options.length,
  });

  const activity = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: pollCard.card,
      },
    ],
  };

  // Send poll via proactive conversation (Adaptive Cards require direct activity send)
  const messageId = await sendProactiveActivity({
    adapter,
    appId,
    ref,
    activity,
    errorPrefix: "msteams poll send",
  });

  log.info("sent poll", { conversationId, pollId: pollCard.pollId, messageId });

  return {
    pollId: pollCard.pollId,
    messageId,
    conversationId,
  };
}

/**
 * Send an arbitrary Adaptive Card to a Teams conversation or user.
 */
export async function sendAdaptiveCardMSTeams(
  params: SendMSTeamsCardParams,
): Promise<SendMSTeamsCardResult> {
  const { cfg, to, card } = params;
  const { adapter, appId, conversationId, ref, log } = await resolveMSTeamsSendContext({
    cfg,
    to,
  });

  log.debug?.("sending adaptive card", {
    conversationId,
    cardType: card.type,
    cardVersion: card.version,
  });

  const activity = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: card,
      },
    ],
  };

  // Send card via proactive conversation
  const messageId = await sendProactiveActivity({
    adapter,
    appId,
    ref,
    activity,
    errorPrefix: "msteams card send",
  });

  log.info("sent adaptive card", { conversationId, messageId });

  return {
    messageId,
    conversationId,
  };
}

export type EditMSTeamsMessageParams = {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID or user ID */
  to: string;
  /** Activity ID of the message to edit */
  activityId: string;
  /** New message text */
  text: string;
};

export type EditMSTeamsMessageResult = {
  conversationId: string;
};

export type DeleteMSTeamsMessageParams = {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID or user ID */
  to: string;
  /** Activity ID of the message to delete */
  activityId: string;
};

export type DeleteMSTeamsMessageResult = {
  conversationId: string;
};

/**
 * Edit (update) a previously sent message in a Teams conversation.
 *
 * Uses the Bot Framework `continueConversation` → `updateActivity` flow
 * for proactive edits outside of the original turn context.
 */
export async function editMessageMSTeams(
  params: EditMSTeamsMessageParams,
): Promise<EditMSTeamsMessageResult> {
  const { cfg, to, activityId, text } = params;
  const { adapter, appId, conversationId, ref, log } = await resolveMSTeamsSendContext({
    cfg,
    to,
  });

  log.debug?.("editing proactive message", { conversationId, activityId, textLength: text.length });

  const baseRef = buildConversationReference(ref);
  const proactiveRef = { ...baseRef, activityId: undefined };

  try {
    await adapter.continueConversation(appId, proactiveRef, async (ctx) => {
      await ctx.updateActivity({
        type: "message",
        id: activityId,
        text,
      });
    });
  } catch (err) {
    const classification = classifyMSTeamsSendError(err);
    const hint = formatMSTeamsSendErrorHint(classification);
    const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
    throw new Error(
      `msteams edit failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`,
      { cause: err },
    );
  }

  log.info("edited proactive message", { conversationId, activityId });

  return { conversationId };
}

/**
 * Delete a previously sent message in a Teams conversation.
 *
 * Uses the Bot Framework `continueConversation` → `deleteActivity` flow
 * for proactive deletes outside of the original turn context.
 */
export async function deleteMessageMSTeams(
  params: DeleteMSTeamsMessageParams,
): Promise<DeleteMSTeamsMessageResult> {
  const { cfg, to, activityId } = params;
  const { adapter, appId, conversationId, ref, log } = await resolveMSTeamsSendContext({
    cfg,
    to,
  });

  log.debug?.("deleting proactive message", { conversationId, activityId });

  const baseRef = buildConversationReference(ref);
  const proactiveRef = { ...baseRef, activityId: undefined };

  try {
    await adapter.continueConversation(appId, proactiveRef, async (ctx) => {
      await ctx.deleteActivity(activityId);
    });
  } catch (err) {
    const classification = classifyMSTeamsSendError(err);
    const hint = formatMSTeamsSendErrorHint(classification);
    const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
    throw new Error(
      `msteams delete failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`,
      { cause: err },
    );
  }

  log.info("deleted proactive message", { conversationId, activityId });

  return { conversationId };
}

/**
 * List all known conversation references (for debugging/CLI).
 */
export async function listMSTeamsConversations(): Promise<
  Array<{
    conversationId: string;
    userName?: string;
    conversationType?: string;
  }>
> {
  const store = createMSTeamsConversationStoreFs();
  const all = await store.list();
  return all.map(({ conversationId, reference }) => ({
    conversationId,
    userName: reference.user?.name,
    conversationType: reference.conversation?.conversationType,
  }));
}
