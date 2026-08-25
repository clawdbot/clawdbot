// Mattermost plugin module implements reply delivery behavior.
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import {
  deliverTextOrMediaReply,
  isReasoningReplyPayload,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { requiresMattermostMediaUpload, resolveMattermostPresentation } from "../normalize.js";
import type { MattermostSendResult } from "./send.js";

type MarkdownTableMode = Parameters<PluginRuntime["channel"]["text"]["convertMarkdownTables"]>[1];

type SendMattermostMessage = (
  to: string,
  text: string,
  opts: {
    cfg: OpenClawConfig;
    accountId?: string;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    requireMediaUpload?: boolean;
    replyToId?: string;
    buttons?: Array<unknown>;
  },
) => Promise<MattermostSendResult>;

/**
 * Result of `deliverMattermostReplyPayload`. Inbound delivery adapters use this
 * to distinguish a successful visible send from an intentionally suppressed
 * reasoning payload from a substantive payload that ended up sending nothing
 * (the silent-completion symptom in #80501).
 */
export type MattermostReplyDeliveryOutcome = "reasoning_skipped" | "empty" | "text" | "media";

export type MattermostReplyDeliveryResult = {
  outcome: MattermostReplyDeliveryOutcome;
  messageIds?: string[];
  receipt?: MessageReceipt;
  visibleReplySent: boolean;
  content?: string;
  suppression?: { reason: "no_visible_result" };
};

/** Represents distinct provider posts without collapsing their visible boundary. */
export function joinMattermostVisibleContent(contents: readonly (string | undefined)[]): string {
  return contents.filter((content): content is string => Boolean(content)).join("\n");
}

export async function deliverMattermostReplyPayload(params: {
  core: PluginRuntime;
  cfg: OpenClawConfig;
  payload: ReplyPayload;
  channelId: string;
  accountId: string;
  agentId?: string;
  replyToId?: string;
  textLimit: number;
  tableMode: MarkdownTableMode;
  sendMessage: SendMattermostMessage;
}): Promise<MattermostReplyDeliveryResult> {
  if (isReasoningReplyPayload(params.payload)) {
    return {
      outcome: "reasoning_skipped",
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    };
  }
  const presentation = resolveMattermostPresentation(params.payload);
  const reply = resolveSendableOutboundReplyParts(params.payload, {
    text: params.core.channel.text.convertMarkdownTables(presentation.text, params.tableMode),
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.agentId);
  const chunkMode = params.core.channel.text.resolveChunkMode(
    params.cfg,
    "mattermost",
    params.accountId,
  );
  const results: MattermostSendResult[] = [];
  const acceptedContents: string[] = [];
  const sendAccepted = async (text: string, mediaUrl?: string) => {
    const result = await params.sendMessage(`channel:${params.channelId}`, text, {
      cfg: params.cfg,
      accountId: params.accountId,
      ...(mediaUrl ? { mediaUrl, mediaLocalRoots } : {}),
      // Local media must upload successfully instead of silently posting only its caption.
      ...(requiresMattermostMediaUpload(mediaUrl) ? { requireMediaUpload: true } : {}),
      ...(results.length === 0 && reply.mediaUrls.length < 2 && presentation.buttons.length
        ? { buttons: presentation.buttons }
        : {}),
      replyToId: params.replyToId,
    });
    results.push(result);
    acceptedContents.push(result.content);
  };
  let outcome: Exclude<MattermostReplyDeliveryOutcome, "reasoning_skipped">;
  try {
    outcome = await deliverTextOrMediaReply({
      payload: params.payload,
      text: reply.text,
      chunkText: (value) =>
        params.core.channel.text.chunkMarkdownTextWithMode(value, params.textLimit, chunkMode),
      sendText: sendAccepted,
      sendMedia: ({ mediaUrl, caption }) => sendAccepted(caption ?? "", mediaUrl),
    });
  } catch (error: unknown) {
    const failedPartial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
    if (results.length === 0 && failedPartial?.visibleReplySent !== true) {
      throw error;
    }
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        ...results.map((result) => ({ receipt: result.receipt })),
        ...(failedPartial?.receipt
          ? [{ receipt: failedPartial.receipt }]
          : (failedPartial?.messageIds ?? []).map((messageId) => ({ messageId }))),
      ],
      kind: reply.mediaUrls.length > 0 ? "media" : "text",
      ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    });
    throw createChannelPartialDeliveryError(error, {
      messageIds: listMessageReceiptPlatformIds(receipt),
      receipt,
      visibleReplySent: true,
      content: joinMattermostVisibleContent([...acceptedContents, failedPartial?.content]),
    });
  }

  if (outcome === "empty") {
    return {
      outcome,
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    };
  }
  const receipt = createMessageReceiptFromOutboundResults({
    results: results.map((result) => ({ receipt: result.receipt })),
    kind: outcome,
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
  });
  return {
    outcome,
    messageIds: listMessageReceiptPlatformIds(receipt),
    receipt,
    visibleReplySent: true,
    content: joinMattermostVisibleContent(acceptedContents),
  };
}
