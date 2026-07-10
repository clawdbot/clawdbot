// Slack plugin module implements replies behavior.
import type { MessageMetadata } from "@slack/types";
import type { Block, KnownBlock } from "@slack/web-api";
import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  chunkMarkdownTextWithMode,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  type ChunkMode,
} from "openclaw/plugin-sdk/reply-chunking";
import {
  deliverTextOrMediaReply,
  getReplyPayloadTtsSupplement,
  resolveSendableOutboundReplyParts,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { createReplyReferencePlanner } from "openclaw/plugin-sdk/reply-reference";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  appendSlackDataVisualizationFallbackText,
  hasSlackDataVisualizationBlock,
  isSlackInvalidBlocksError,
} from "../data-visualization.js";
import { markdownToSlackMrkdwnChunks } from "../format.js";
import { SLACK_TEXT_LIMIT } from "../limits.js";
import { emitSlackMessageSentHooks } from "../message-sent-hook.js";
import { resolveSlackReplyBlocks, resolveSlackReplyText } from "../reply-blocks.js";
import { truncateSlackText } from "../truncate.js";
import type { SlackEventScope } from "./event-scope.js";
import { sendMessageSlack, type SlackSendIdentity, type SlackSendResult } from "./send.runtime.js";

export function readSlackReplyBlocks(payload: ReplyPayload) {
  return resolveSlackReplyBlocks(payload);
}

function resolveSlackMediaHookSpokenText(payload: ReplyPayload): string | undefined {
  const spokenText = getReplyPayloadTtsSupplement(payload)?.spokenText ?? payload.spokenText;
  return spokenText?.trim() || undefined;
}

export function resolveDeliveredSlackReplyThreadTs(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  payloadReplyToId?: string;
  replyThreadTs?: string;
}): string | undefined {
  // Keep reply tags opt-in: when replyToMode is off, explicit reply tags
  // must not force threading.
  const inlineReplyToId = params.replyToMode === "off" ? undefined : params.payloadReplyToId;
  return inlineReplyToId ?? params.replyThreadTs;
}

export async function deliverReplies(params: {
  cfg: OpenClawConfig;
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  runtime: RuntimeEnv;
  textLimit: number;
  mediaMaxBytes?: number;
  replyThreadTs?: string;
  replyToMode: "off" | "first" | "all" | "batched";
  identity?: SlackSendIdentity;
  metadata?: MessageMetadata;
  /** Logical conversation target used by lifecycle hooks when delivery uses a physical Slack id. */
  messageSentHookTarget?: string;
  /**
   * Canonical session key for the internal `message:sent` hook. When set, the
   * internal hook fires alongside the plugin `message_sent` hook. The plugin
   * hook fires regardless (self-gated on registered listeners).
   */
  sessionKeyForInternalHooks?: string;
  /** Whether the reply target is a group/channel (vs a DM). */
  isGroup?: boolean;
  /** Group/channel id for the `message_sent` event when `isGroup` is true. */
  groupId?: string;
  /**
   * Defer hook emission to a caller that must resolve another delivery path
   * before reporting the terminal outcome.
   */
  deferMessageSentHooks?: true;
  /** Validated non-serializable client scope for an enterprise listener turn. */
  eventScope?: SlackEventScope;
}) {
  let latestResult: SlackSendResult | undefined;
  const sendReply = async (input: {
    text: string;
    threadTs?: string | undefined;
    mediaUrl?: string | undefined;
    blocks?: (Block | KnownBlock)[] | undefined;
  }): Promise<SlackSendResult> => {
    return await sendMessageSlack(params.target, input.text, {
      cfg: params.cfg,
      token: params.token,
      threadTs: input.threadTs,
      accountId: params.accountId,
      mediaUrl: input.mediaUrl,
      blocks: input.blocks,
      ...(params.eventScope
        ? {
            client: params.eventScope.client,
            enterpriseEventScope: params.eventScope,
            textLimit: params.textLimit,
            ...(params.mediaMaxBytes !== undefined ? { mediaMaxBytes: params.mediaMaxBytes } : {}),
          }
        : {}),
      ...(params.identity ? { identity: params.identity } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    });
  };
  for (const payload of params.replies) {
    if (payload.isReasoning === true) {
      continue;
    }
    const threadTs = resolveDeliveredSlackReplyThreadTs({
      replyToMode: params.replyToMode,
      payloadReplyToId: payload.replyToId,
      replyThreadTs: params.replyThreadTs,
    });
    const reply = resolveSendableOutboundReplyParts(payload);
    const slackBlocks = readSlackReplyBlocks(payload);
    if (!reply.hasContent && !slackBlocks?.length) {
      continue;
    }

    // Fire the `message_sent` hook(s) after delivery, mirroring Telegram's
    // `emitMessageSentHooks` in `extensions/telegram/src/bot/delivery.replies.ts`.
    // `emitSlackMessageSentHooks` self-gates on registered listeners, so this is
    // a no-op when no plugin observes `message_sent`.
    const emitSent = (content: string, result?: SlackSendResult) => {
      if (params.deferMessageSentHooks) {
        return;
      }
      emitSlackMessageSentHooks({
        sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
        to: params.messageSentHookTarget ?? params.target,
        accountId: params.accountId,
        content,
        success: true,
        messageId: result?.messageId,
        isGroup: params.isGroup,
        groupId: params.groupId,
      });
    };
    const emitFailed = (content: string, error: unknown) => {
      if (params.deferMessageSentHooks) {
        return;
      }
      emitSlackMessageSentHooks({
        sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
        to: params.messageSentHookTarget ?? params.target,
        accountId: params.accountId,
        content,
        success: false,
        error: formatErrorMessage(error),
        isGroup: params.isGroup,
        groupId: params.groupId,
      });
    };

    if (!reply.hasMedia && slackBlocks?.length) {
      const trimmed = resolveSlackReplyText(payload, reply.trimmedText).trim();
      if (!trimmed && !slackBlocks?.length) {
        continue;
      }
      if (trimmed && isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
        continue;
      }
      let result: SlackSendResult;
      try {
        result = await sendReply({
          text: trimmed,
          threadTs,
          ...(slackBlocks?.length ? { blocks: slackBlocks } : {}),
        });
      } catch (error) {
        emitFailed(trimmed, error);
        throw error;
      }
      emitSent(trimmed, result);
      latestResult = result;
      params.runtime.log?.(`delivered reply to ${params.target}`);
      continue;
    }

    const spokenText = resolveSlackMediaHookSpokenText(payload);
    const mediaHookContent = reply.hasText ? reply.text : spokenText || reply.text;
    const hookContent = reply.hasMedia ? mediaHookContent : reply.trimmedText;
    let lastResult: SlackSendResult | undefined;
    let delivered: Awaited<ReturnType<typeof deliverTextOrMediaReply>>;
    try {
      delivered = await deliverTextOrMediaReply({
        payload,
        text: reply.text,
        chunkText: !reply.hasMedia
          ? (value) => {
              const trimmed = value.trim();
              if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
                return [];
              }
              return [trimmed];
            }
          : undefined,
        sendText: async (trimmed) => {
          lastResult = await sendReply({
            text: trimmed,
            threadTs,
          });
        },
        sendMedia: async ({ mediaUrl, caption }) => {
          lastResult = await sendReply({
            text: caption ?? "",
            mediaUrl,
            threadTs,
          });
        },
      });
      if (reply.hasMedia && slackBlocks?.length) {
        // Slack file uploads cannot carry blocks. Preserve their ordering and
        // report one terminal outcome only after the trailing block message.
        const text = resolveSlackReplyText(payload, reply.trimmedText).trim();
        lastResult = await sendReply({
          text,
          threadTs,
          blocks: slackBlocks,
        });
      }
    } catch (error) {
      emitFailed(hookContent, error);
      throw error;
    }
    if (delivered !== "empty") {
      // Preserve the media hook contract even when a trailing block send has a
      // message `ts`; the logical payload still spans multiple Slack objects.
      emitSent(hookContent, reply.hasMedia ? undefined : lastResult);
      latestResult = lastResult;
      params.runtime.log?.(`delivered reply to ${params.target}`);
    }
  }
  return latestResult;
}

export type SlackRespondFn = (payload: {
  text: string;
  blocks?: ReturnType<typeof readSlackReplyBlocks>;
  response_type?: "ephemeral" | "in_channel";
}) => Promise<unknown>;

/**
 * Compute effective threadTs for a Slack reply based on replyToMode.
 * - "off": stay in thread if already in one, otherwise main channel
 * - "first": first reply goes to thread, subsequent replies to main channel
 * - "all": all replies go to thread
 */
export function resolveSlackThreadTs(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasReplied: boolean;
  isThreadReply?: boolean;
}): string | undefined {
  const planner = createSlackReplyReferencePlanner({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: params.hasReplied,
    isThreadReply: params.isThreadReply,
  });
  return planner.use();
}

type SlackReplyDeliveryPlan = {
  peekThreadTs: () => string | undefined;
  nextThreadTs: () => string | undefined;
  markSent: () => void;
};

function createSlackReplyReferencePlanner(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasReplied?: boolean;
  isThreadReply?: boolean;
}) {
  // Older/internal callers may not pass explicit thread classification. Keep
  // genuine thread replies sticky, but do not let Slack's auto-populated
  // top-level thread_ts override the configured replyToMode.
  const effectiveIsThreadReply =
    params.isThreadReply ??
    Boolean(params.incomingThreadTs && params.incomingThreadTs !== params.messageTs);
  const effectiveMode = effectiveIsThreadReply ? "all" : params.replyToMode;
  return createReplyReferencePlanner({
    replyToMode: effectiveMode,
    existingId: params.incomingThreadTs,
    startId: params.messageTs,
    hasReplied: params.hasReplied,
  });
}

export function createSlackReplyDeliveryPlan(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasRepliedRef: { value: boolean };
  isThreadReply?: boolean;
}): SlackReplyDeliveryPlan {
  const replyReference = createSlackReplyReferencePlanner({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: params.hasRepliedRef.value,
    isThreadReply: params.isThreadReply,
  });
  return {
    peekThreadTs: () => replyReference.peek(),
    nextThreadTs: () => replyReference.use(),
    markSent: () => {
      replyReference.markSent();
      params.hasRepliedRef.value = replyReference.hasReplied();
    },
  };
}

export async function deliverSlackSlashReplies(params: {
  replies: ReplyPayload[];
  respond: SlackRespondFn;
  ephemeral: boolean;
  textLimit: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  messageSentHookTarget?: string;
  accountId?: string;
  sessionKeyForInternalHooks?: string;
  isGroup?: boolean;
  groupId?: string;
}) {
  const deliveries: Array<{
    hookContent: string;
    messages: Array<{ text: string; blocks?: ReturnType<typeof readSlackReplyBlocks> }>;
  }> = [];
  const chunkLimit = Math.min(params.textLimit, SLACK_TEXT_LIMIT);
  for (const payload of params.replies) {
    if (payload.isReasoning === true) {
      continue;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    const slackBlocks = readSlackReplyBlocks(payload);
    const textRaw =
      reply.hasText && !isSilentReplyText(reply.trimmedText, SILENT_REPLY_TOKEN)
        ? reply.trimmedText
        : undefined;
    const text = slackBlocks?.length
      ? truncateSlackText(
          appendSlackDataVisualizationFallbackText(
            resolveSlackReplyText(payload, textRaw),
            slackBlocks,
          ),
          SLACK_TEXT_LIMIT,
        ).trim()
      : textRaw;
    if (slackBlocks?.length && !reply.hasMedia) {
      deliveries.push({
        hookContent: text ?? "",
        messages: [{ text: text ?? "", blocks: slackBlocks }],
      });
      continue;
    }
    const combined = [text ?? "", ...reply.mediaUrls].filter(Boolean).join("\n");
    if (!combined) {
      continue;
    }
    const chunkMode = params.chunkMode ?? "length";
    const markdownChunks =
      chunkMode === "newline"
        ? chunkMarkdownTextWithMode(combined, chunkLimit, chunkMode)
        : [combined];
    const chunks = markdownChunks.flatMap((markdown) =>
      markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode: params.tableMode }),
    );
    if (!chunks.length && combined) {
      chunks.push(combined);
    }
    deliveries.push({
      hookContent: text ?? resolveSlackMediaHookSpokenText(payload) ?? combined,
      messages: chunks.map((chunk) => ({ text: chunk })),
    });
  }

  if (deliveries.length === 0) {
    return;
  }

  // Slack slash command responses can be multi-part by sending follow-ups via response_url.
  const responseType = params.ephemeral ? "ephemeral" : "in_channel";
  for (const delivery of deliveries) {
    try {
      for (const message of delivery.messages) {
        const hasNativeChart = hasSlackDataVisualizationBlock(message.blocks);
        try {
          const response = await params.respond({ ...message, response_type: responseType });
          if (!hasNativeChart || !isSlackInvalidBlocksError(response)) {
            continue;
          }
        } catch (error) {
          if (!hasNativeChart || !isSlackInvalidBlocksError(error)) {
            throw error;
          }
        }
        await params.respond({
          text: truncateSlackText(
            appendSlackDataVisualizationFallbackText(message.text, message.blocks),
            SLACK_TEXT_LIMIT,
          ),
          response_type: responseType,
        });
      }
    } catch (error) {
      if (params.messageSentHookTarget) {
        emitSlackMessageSentHooks({
          sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
          to: params.messageSentHookTarget,
          accountId: params.accountId,
          content: delivery.hookContent,
          success: false,
          error: formatErrorMessage(error),
          isGroup: params.isGroup,
          groupId: params.groupId,
        });
      }
      throw error;
    }
    if (params.messageSentHookTarget) {
      emitSlackMessageSentHooks({
        sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
        to: params.messageSentHookTarget,
        accountId: params.accountId,
        content: delivery.hookContent,
        success: true,
        isGroup: params.isGroup,
        groupId: params.groupId,
      });
    }
  }
}
