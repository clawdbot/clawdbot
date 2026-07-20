/**
 * Outbound ClickClack delivery helpers for channel messages, thread replies,
 * and direct messages.
 */
import { createHash } from "node:crypto";
import {
  createMessageReceiptFromOutboundResults,
  type ChannelMessageUnknownSendContext,
  type ChannelMessageUnknownSendReconciliationResult,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  loadOutboundMediaFromUrl,
  type OutboundMediaLoadOptions,
} from "openclaw/plugin-sdk/outbound-media";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { resolveClickClackAccount } from "./accounts.js";
import { createClickClackClient, type ClickClackClient } from "./http-client.js";
import { resolveChannelId, resolveWorkspaceId } from "./resolve.js";
import { parseClickClackTarget } from "./target.js";
import type { ClickClackMessage, ClickClackMessageProvenance, CoreConfig } from "./types.js";

const CLICKCLACK_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

async function createTargetMessage(params: {
  client: ClickClackClient;
  workspaceId: string;
  to: string;
  text: string;
  threadId?: string | number | null;
  replyToId?: string | number | null;
  provenance?: ClickClackMessageProvenance;
  nonce?: string;
  onPlatformSendDispatch?: () => Promise<void>;
}): Promise<ClickClackMessage> {
  const parsed = parseClickClackTarget(params.to);
  const explicitThreadId = params.threadId == null ? "" : String(params.threadId);
  const replyToId = params.replyToId == null ? "" : String(params.replyToId);
  if (explicitThreadId || parsed.kind === "thread") {
    // Genuine thread context stays in that thread. A bare reply to a top-level
    // message remains a quote-reply so it does not silently leave the timeline.
    const rootId = explicitThreadId || parsed.id;
    await params.onPlatformSendDispatch?.();
    return await params.client.createThreadReply(rootId, params.text, {
      provenance: params.provenance,
      nonce: params.nonce,
    });
  }
  if (parsed.kind === "dm") {
    await params.onPlatformSendDispatch?.();
    const dm = await params.client.createDirectConversation(params.workspaceId, [parsed.id]);
    return await params.client.createDirectMessage(dm.id, params.text, {
      quotedMessageId: replyToId || undefined,
      nonce: params.nonce,
    });
  }
  const channelId = await resolveChannelId(params.client, params.workspaceId, parsed.id);
  await params.onPlatformSendDispatch?.();
  return await params.client.createChannelMessage(channelId, params.text, {
    provenance: params.provenance,
    quotedMessageId: replyToId || undefined,
    nonce: params.nonce,
  });
}

function durableDeliveryDigest(params: {
  deliveryQueueId?: string;
  deliveryPartIndex?: number;
}): string | undefined {
  if (!params.deliveryQueueId) {
    return undefined;
  }
  if (!Number.isSafeInteger(params.deliveryPartIndex) || (params.deliveryPartIndex ?? -1) < 0) {
    throw new Error("ClickClack durable delivery requires a stable delivery part index");
  }
  return createHash("sha256")
    .update(`${params.deliveryQueueId}\n${params.deliveryPartIndex}`)
    .digest("hex");
}

function mediaDeliveryNonces(params: { deliveryQueueId?: string; deliveryPartIndex?: number }): {
  message?: string;
  upload?: string;
} {
  const digest = durableDeliveryDigest(params);
  if (!digest) {
    return {};
  }
  return {
    message: `openclaw-media:${digest}`,
    upload: `openclaw-upload:${digest}`,
  };
}

function textDeliveryNonce(params: {
  deliveryQueueId?: string;
  deliveryPartIndex?: number;
}): string | undefined {
  const digest = durableDeliveryDigest(params);
  return digest ? `openclaw-text:${digest}` : undefined;
}

function createDispatchOnce(onPlatformSendDispatch?: () => Promise<void>): () => Promise<void> {
  let dispatched = false;
  return async () => {
    if (dispatched) {
      return;
    }
    await onPlatformSendDispatch?.();
    dispatched = true;
  };
}

async function attachUploadRetrySafe(params: {
  client: ClickClackClient;
  messageId: string;
  uploadId: string;
}): Promise<void> {
  try {
    await params.client.attachUpload(params.messageId, params.uploadId);
  } catch (firstError) {
    // The attachment write is idempotent. A read distinguishes a lost success
    // response; otherwise one bounded retry reuses the same upload and message.
    try {
      const persisted = await params.client.message(params.messageId);
      if (persisted.attachments?.some((attachment) => attachment.id === params.uploadId)) {
        return;
      }
    } catch {
      // A failed reconciliation read must not prevent the safe attach retry.
    }
    try {
      await params.client.attachUpload(params.messageId, params.uploadId);
    } catch {
      throw firstError;
    }
  }
}

function createOutboundContext(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  correlationId?: string;
}) {
  const account = resolveClickClackAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createClickClackClient({
    baseUrl: account.apiEndpoint,
    token: account.token,
    correlationId: params.correlationId,
  });
  return { account, client };
}

/**
 * Sends visible text to a normalized ClickClack target and returns the created
 * message id, or undefined when sanitization removes all content.
 */
export async function sendClickClackText(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  text: string;
  threadId?: string | number | null;
  replyToId?: string | number | null;
  /** Safe request correlation inherited from an inbound ClickClack event. */
  correlationId?: string;
  /** Optional model/thinking attribution stamped onto the created message. */
  provenance?: ClickClackMessageProvenance;
  /** Opaque durable intent id used only to derive ClickClack's message nonce. */
  deliveryQueueId?: string;
  /** Stable platform-send index within the durable intent. */
  deliveryPartIndex?: number;
  /** Persists unknown-send state immediately before the first platform write. */
  onPlatformSendDispatch?: () => Promise<void>;
}): Promise<string | undefined> {
  // Custom inbound replies bypass shared outbound normalization, so this private
  // sender owns ClickClack assistant-text sanitization for every delivery path.
  const text = sanitizeAssistantVisibleText(params.text);
  if (!text) {
    return undefined;
  }
  const { account, client } = createOutboundContext(params);
  const workspaceId = await resolveWorkspaceId(client, account.workspace);
  const dispatch = createDispatchOnce(params.onPlatformSendDispatch);
  const message = await createTargetMessage({
    client,
    workspaceId,
    to: params.to,
    text,
    threadId: params.threadId,
    replyToId: params.replyToId,
    provenance: params.provenance,
    nonce: textDeliveryNonce({
      deliveryQueueId: params.deliveryQueueId,
      deliveryPartIndex: params.deliveryPartIndex,
    }),
    onPlatformSendDispatch: dispatch,
  });
  return message.id;
}

/** Resolves, uploads, sends, then attaches one file to a ClickClack message. */
export async function sendClickClackMedia(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  text: string;
  mediaUrl: string;
  mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  threadId?: string | number | null;
  replyToId?: string | number | null;
  /** Opaque durable intent id used only to derive ClickClack's message nonce. */
  deliveryQueueId?: string;
  /** Stable platform-send index within the durable intent. */
  deliveryPartIndex?: number;
  /** Persists unknown-send state immediately before the first platform write. */
  onPlatformSendDispatch?: () => Promise<void>;
}): Promise<string> {
  const nonces = mediaDeliveryNonces({
    deliveryQueueId: params.deliveryQueueId,
    deliveryPartIndex: params.deliveryPartIndex,
  });
  const preloadedMedia = nonces.upload
    ? undefined
    : await loadOutboundMediaFromUrl(params.mediaUrl, {
        maxBytes: CLICKCLACK_MAX_UPLOAD_BYTES,
        mediaAccess: params.mediaAccess,
        mediaLocalRoots: params.mediaLocalRoots,
        mediaReadFile: params.mediaReadFile,
      });
  const { account, client } = createOutboundContext(params);
  const workspaceId = await resolveWorkspaceId(client, account.workspace);
  const persistedUpload = nonces.upload
    ? await client.findUploadByNonce({ workspaceId, nonce: nonces.upload })
    : undefined;
  const dispatch = createDispatchOnce(params.onPlatformSendDispatch);
  let upload = persistedUpload;
  let mediaFilename = preloadedMedia?.fileName?.trim();
  if (!upload) {
    const media =
      preloadedMedia ??
      (await loadOutboundMediaFromUrl(params.mediaUrl, {
        maxBytes: CLICKCLACK_MAX_UPLOAD_BYTES,
        mediaAccess: params.mediaAccess,
        mediaLocalRoots: params.mediaLocalRoots,
        mediaReadFile: params.mediaReadFile,
      }));
    const filename = media.fileName?.trim() || "attachment";
    mediaFilename = filename;
    const contentType = media.contentType?.trim() || "application/octet-stream";
    await dispatch();
    upload = await client.createUpload({
      workspaceId,
      buffer: media.buffer,
      filename,
      contentType,
      ...(nonces.upload ? { nonce: nonces.upload } : {}),
    });
  }
  const text =
    sanitizeAssistantVisibleText(params.text) || mediaFilename || upload.filename || "attachment";
  // Upload-first ordering lets crash recovery identify the durable object before
  // it creates or repairs the corresponding message.
  const message = await createTargetMessage({
    client,
    workspaceId,
    to: params.to,
    text,
    threadId: params.threadId,
    replyToId: params.replyToId,
    nonce: nonces.message,
    onPlatformSendDispatch: dispatch,
  });
  // Do not report delivery until ClickClack has durably attached the upload and
  // emitted message.updated; otherwise callers would accept a text-only receipt.
  await attachUploadRetrySafe({ client, messageId: message.id, uploadId: upload.id });
  return message.id;
}

function collectReconciliationMediaUrls(ctx: ChannelMessageUnknownSendContext): string[] {
  const planned = ctx.renderedBatchPlan?.items[0]?.mediaUrls;
  if (planned?.length) {
    return planned.map((url) => url.trim()).filter(Boolean);
  }
  const payload = ctx.payloads[0];
  return [payload?.mediaUrl, ...(payload?.mediaUrls ?? [])]
    .map((url) => url?.trim())
    .filter((url): url is string => Boolean(url));
}

/**
 * Completes an unknown durable send through ClickClack's message/upload nonces.
 * Media recovery never rereads the original source after restart.
 */
export async function reconcileClickClackUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
): Promise<ChannelMessageUnknownSendReconciliationResult> {
  if (ctx.payloads.length !== 1 || (ctx.renderedBatchPlan?.items.length ?? 1) !== 1) {
    return {
      status: "unresolved",
      error: "ClickClack reconciliation requires exactly one payload",
    };
  }
  const mediaUrls = collectReconciliationMediaUrls(ctx);
  const { account, client } = createOutboundContext({
    cfg: ctx.cfg as CoreConfig,
    accountId: ctx.accountId,
  });
  const workspaceId = await resolveWorkspaceId(client, account.workspace);
  const effectiveReplyToId =
    ctx.effectiveReplyToId !== undefined
      ? ctx.effectiveReplyToId
      : ctx.replyToMode === "off"
        ? undefined
        : ctx.replyToId;
  const payload = ctx.payloads[0];
  const caption = ctx.renderedBatchPlan?.items[0]?.text ?? payload?.text ?? "";
  if (mediaUrls.length === 0) {
    const nonce = textDeliveryNonce({
      deliveryQueueId: ctx.queueId,
      deliveryPartIndex: 0,
    });
    if (!nonce || !sanitizeAssistantVisibleText(caption)) {
      return { status: "not_sent" };
    }
    const message = await client.findMessageByNonce({ workspaceId, nonce });
    if (!message) {
      return { status: "not_sent" };
    }
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "clickclack", messageId: message.id }],
      threadId: ctx.threadId == null ? undefined : String(ctx.threadId),
      replyToId: effectiveReplyToId ?? undefined,
      kind: "text",
    });
    return { status: "sent", messageId: message.id, receipt };
  }

  const parts = await Promise.all(
    mediaUrls.map(async (_mediaUrl, index) => {
      const nonces = mediaDeliveryNonces({
        deliveryQueueId: ctx.queueId,
        deliveryPartIndex: index,
      });
      if (!nonces.upload || !nonces.message) {
        throw new Error("ClickClack durable media nonces were not derived");
      }
      const [upload, message] = await Promise.all([
        client.findUploadByNonce({ workspaceId, nonce: nonces.upload }),
        client.findMessageByNonce({ workspaceId, nonce: nonces.message }),
      ]);
      return {
        upload,
        message,
      };
    }),
  );
  for (const part of parts) {
    if (part.message && !part.upload) {
      return {
        status: "unresolved",
        error: `ClickClack message ${part.message.id} exists without its nonce-keyed upload`,
        retryable: false,
      };
    }
    if (!part.message) {
      return { status: "not_sent" };
    }
  }

  const messageIds: string[] = [];
  for (const part of parts) {
    const message = part.message;
    const upload = part.upload;
    if (!message || !upload) {
      throw new Error("ClickClack reconciliation state changed unexpectedly");
    }
    if (!message.attachments?.some((attachment) => attachment.id === upload.id)) {
      await attachUploadRetrySafe({ client, messageId: message.id, uploadId: upload.id });
    }
    messageIds.push(message.id);
  }

  const receipt = createMessageReceiptFromOutboundResults({
    results: messageIds.map((messageId) => ({ channel: "clickclack", messageId })),
    threadId: ctx.threadId == null ? undefined : String(ctx.threadId),
    replyToId: effectiveReplyToId ?? undefined,
    kind: "media",
  });
  const messageId = messageIds.at(-1);
  return { status: "sent", ...(messageId ? { messageId } : {}), receipt };
}
