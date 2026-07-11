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
import { buildSlackDeferredNativeDataRejectionFallback } from "../blocks-fallback.js";
import { chunkSlackMrkdwnText, markdownToSlackMrkdwnChunks } from "../format.js";
import { SLACK_RESPONSE_URL_MAX_USES, SLACK_TEXT_LIMIT } from "../limits.js";
import { emitSlackMessageSentHooks } from "../message-sent-hook.js";
import {
  appendSlackNativeDataFallbackText,
  buildSlackNativeDataFallbackBlocks,
  hasCompleteSlackNativeDataFallbackText,
  hasSlackNativeDataBlock,
  isSlackInvalidBlocksError,
} from "../native-data-blocks.js";
import { resolveSlackReplyRenderPlan } from "../reply-blocks.js";
import { truncateSlackText } from "../truncate.js";
import type { SlackEventScope } from "./event-scope.js";
import { sendMessageSlack, type SlackSendIdentity, type SlackSendResult } from "./send.runtime.js";

export function readSlackReplyBlocks(payload: ReplyPayload) {
  const plan = resolveSlackReplyRenderPlan(payload);
  return plan.mode === "single" ? plan.blocks : plan.blockPart?.blocks;
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
    separateTextAndBlocks?: boolean;
    textIsSlackMrkdwn?: boolean;
  }): Promise<SlackSendResult> => {
    return await sendMessageSlack(params.target, input.text, {
      cfg: params.cfg,
      token: params.token,
      threadTs: input.threadTs,
      accountId: params.accountId,
      mediaUrl: input.mediaUrl,
      blocks: input.blocks,
      ...(input.separateTextAndBlocks ? { separateTextAndBlocks: true } : {}),
      ...(input.textIsSlackMrkdwn ? { textIsSlackMrkdwn: true } : {}),
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
    const renderText =
      reply.hasText && !isSilentReplyText(reply.trimmedText, SILENT_REPLY_TOKEN)
        ? reply.trimmedText
        : undefined;
    const renderPlan = resolveSlackReplyRenderPlan(payload, renderText, {
      includeAuthoredTextBlock: !reply.hasMedia,
    });
    const slackBlocks =
      renderPlan.mode === "single" ? renderPlan.blocks : renderPlan.blockPart?.blocks;
    const tableFallbackText =
      renderPlan.mode === "split" ? renderPlan.fallbackText.trim() : undefined;
    const mediaBlockPartOwnsFallback = Boolean(
      reply.hasMedia &&
      renderPlan.mode === "split" &&
      renderPlan.blockPart &&
      hasCompleteSlackNativeDataFallbackText(renderPlan.fallbackText, renderPlan.blockPart.blocks),
    );
    if (!reply.hasContent && !slackBlocks?.length && !tableFallbackText) {
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

    if (renderPlan.mode === "single" && !reply.hasMedia && slackBlocks?.length) {
      const trimmed = renderPlan.text.trim();
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
          ...(renderPlan.textIsSlackMrkdwn ? { textIsSlackMrkdwn: true } : {}),
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
    if (renderPlan.mode === "split" && !reply.hasMedia) {
      const trimmed = renderPlan.fallbackText.trim();
      if (!trimmed && !renderPlan.blockPart) {
        continue;
      }
      try {
        const result = await sendReply({
          text: trimmed,
          threadTs,
          ...(renderPlan.blockPart
            ? {
                blocks: renderPlan.blockPart.blocks,
                separateTextAndBlocks: true,
              }
            : {}),
          textIsSlackMrkdwn: true,
        });
        emitSent(renderPlan.hookText, result);
        latestResult = result;
      } catch (error) {
        emitFailed(renderPlan.hookText, error);
        throw error;
      }
      params.runtime.log?.(`delivered reply to ${params.target}`);
      continue;
    }

    const spokenText = resolveSlackMediaHookSpokenText(payload);
    const mediaHookContent = reply.hasText ? reply.text : spokenText || reply.text;
    const deliveryText =
      (mediaBlockPartOwnsFallback ? "" : tableFallbackText) ??
      (reply.hasMedia && renderPlan.mode === "single" && renderPlan.textVisibleInBlocks
        ? ""
        : reply.text);
    const hookContent =
      renderPlan.mode === "split"
        ? renderPlan.hookText
        : reply.hasMedia
          ? renderPlan.hookText || mediaHookContent
          : reply.trimmedText;
    let lastResult: SlackSendResult | undefined;
    let delivered: Awaited<ReturnType<typeof deliverTextOrMediaReply>>;
    try {
      delivered = await deliverTextOrMediaReply({
        payload,
        text: deliveryText,
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
            ...(renderPlan.mode === "split" ? { textIsSlackMrkdwn: true } : {}),
          });
        },
        sendMedia: async ({ mediaUrl, caption }) => {
          lastResult = await sendReply({
            text: caption ?? "",
            mediaUrl,
            threadTs,
            ...(renderPlan.mode === "split" ? { textIsSlackMrkdwn: true } : {}),
          });
        },
      });
      if (reply.hasMedia && slackBlocks?.length) {
        // Slack file uploads cannot carry blocks. Preserve their ordering and
        // report one terminal outcome only after the trailing block message.
        const text =
          mediaBlockPartOwnsFallback && renderPlan.mode === "split"
            ? renderPlan.fallbackText
            : renderPlan.mode === "split"
              ? (renderPlan.blockPart?.text ?? "")
              : renderPlan.text.trim();
        lastResult = await sendReply({
          text,
          threadTs,
          blocks: slackBlocks,
          ...(mediaBlockPartOwnsFallback
            ? { separateTextAndBlocks: true, textIsSlackMrkdwn: true }
            : {}),
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

type SlackSlashReplyWireMessage = {
  text: string;
  blocks?: ReturnType<typeof readSlackReplyBlocks>;
};

type SlackSlashReplyMessage = SlackSlashReplyWireMessage & {
  nativeDataRejectionFallback?: SlackSlashReplyWireMessage;
};

type SlackNativeDataFallbackResolution = {
  deferred: boolean;
  message: SlackSlashReplyWireMessage;
};

type SlackSlashReplyDelivery = {
  hookContent: string;
  messages: SlackSlashReplyMessage[];
};

function countSlackResponseUrlUses(deliveries: readonly SlackSlashReplyDelivery[]): number {
  return deliveries.reduce(
    (total, delivery) =>
      total +
      delivery.messages.reduce(
        (messageTotal, message) =>
          messageTotal + 1 + (hasSlackNativeDataBlock(message.blocks) ? 1 : 0),
        0,
      ),
    0,
  );
}

function resolveSlackNativeDataFallback(
  message: SlackSlashReplyMessage,
): SlackNativeDataFallbackResolution | undefined {
  if (!hasSlackNativeDataBlock(message.blocks)) {
    return undefined;
  }
  if (message.nativeDataRejectionFallback) {
    return { deferred: true, message: message.nativeDataRejectionFallback };
  }
  const blocks = buildSlackNativeDataFallbackBlocks(message.blocks);
  return {
    deferred: false,
    message: {
      text: truncateSlackText(
        appendSlackNativeDataFallbackText(message.text, message.blocks),
        SLACK_TEXT_LIMIT,
      ),
      ...(blocks?.length ? { blocks } : {}),
    },
  };
}

function degradeSlackResponseUrlNativeTables(
  deliveries: readonly SlackSlashReplyDelivery[],
  textLimit: number,
): SlackSlashReplyDelivery[] {
  return deliveries
    .map((delivery) => ({
      ...delivery,
      messages: delivery.messages.flatMap((message) => {
        if (!hasSlackNativeDataBlock(message.blocks)) {
          return [message];
        }
        let fallback: SlackNativeDataFallbackResolution | undefined;
        try {
          fallback = resolveSlackNativeDataFallback(message);
        } catch {
          return [message];
        }
        if (!fallback) {
          return [message];
        }
        if (fallback.deferred && !fallback.message.blocks?.length) {
          return [];
        }
        if (fallback.message.text.length > textLimit) {
          return [message];
        }
        return [fallback.message];
      }),
    }))
    .filter((delivery) => delivery.messages.length > 0);
}

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
  responseUrlBudget?: { used: number; closed?: boolean };
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
  const responseUrlBudget = params.responseUrlBudget ?? { used: 0 };
  if (responseUrlBudget.closed) {
    return;
  }
  const deliveries: SlackSlashReplyDelivery[] = [];
  const chunkLimit = Math.min(params.textLimit, SLACK_TEXT_LIMIT);
  for (const payload of params.replies) {
    if (payload.isReasoning === true) {
      continue;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    const textRaw =
      reply.hasText && !isSilentReplyText(reply.trimmedText, SILENT_REPLY_TOKEN)
        ? reply.trimmedText
        : undefined;
    const renderPlan = resolveSlackReplyRenderPlan(payload, textRaw, { textLimit: chunkLimit });
    if (renderPlan.mode === "single" && renderPlan.blocks?.length && !reply.hasMedia) {
      deliveries.push({
        hookContent: renderPlan.hookText,
        messages: [{ text: renderPlan.text, blocks: renderPlan.blocks }],
      });
      continue;
    }
    const text = renderPlan.mode === "split" ? renderPlan.fallbackText : renderPlan.text;
    const combined = [text ?? "", ...reply.mediaUrls].filter(Boolean).join("\n");
    const blockPart = renderPlan.mode === "split" ? renderPlan.blockPart : undefined;
    if (!combined && !blockPart) {
      continue;
    }
    const chunkMode = params.chunkMode ?? "length";
    const chunks =
      combined.length === 0
        ? []
        : renderPlan.mode === "split" || renderPlan.textIsSlackMrkdwn
          ? chunkSlackMrkdwnText(combined, chunkLimit)
          : (chunkMode === "newline"
              ? chunkMarkdownTextWithMode(combined, chunkLimit, chunkMode)
              : [combined]
            ).flatMap((markdown) =>
              markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode: params.tableMode }),
            );
    if (!chunks.length && combined) {
      chunks.push(combined);
    }
    const messages: SlackSlashReplyMessage[] = chunks.map((chunk) => ({ text: chunk }));
    if (blockPart) {
      const ownsLaterNativeDataFallback =
        renderPlan.mode === "split" &&
        hasSlackNativeDataBlock(blockPart.blocks) &&
        hasCompleteSlackNativeDataFallbackText(renderPlan.fallbackText, blockPart.blocks);
      const deferredRejection = ownsLaterNativeDataFallback
        ? buildSlackDeferredNativeDataRejectionFallback(blockPart.blocks)
        : undefined;
      messages.unshift({
        text: blockPart.text,
        blocks: blockPart.blocks,
        ...(deferredRejection
          ? {
              nativeDataRejectionFallback: {
                text: deferredRejection.text,
                ...(deferredRejection.blocks.length > 0
                  ? { blocks: deferredRejection.blocks }
                  : {}),
              },
            }
          : {}),
      });
    }
    deliveries.push({
      hookContent: renderPlan.hookText || resolveSlackMediaHookSpokenText(payload) || combined,
      messages,
    });
  }

  if (deliveries.length === 0) {
    return;
  }
  const responseType = params.ephemeral ? "ephemeral" : "in_channel";
  const responseUrlUsesRemaining = Math.max(
    0,
    SLACK_RESPONSE_URL_MAX_USES - responseUrlBudget.used,
  );
  let plannedDeliveries = deliveries;
  let responseUrlUses = countSlackResponseUrlUses(plannedDeliveries);
  if (responseUrlUses > responseUrlUsesRemaining) {
    const degradedDeliveries = degradeSlackResponseUrlNativeTables(deliveries, chunkLimit);
    const degradedUses = countSlackResponseUrlUses(degradedDeliveries);
    if (degradedUses < responseUrlUses) {
      plannedDeliveries = degradedDeliveries;
      responseUrlUses = degradedUses;
    }
  }
  if (responseUrlUses > responseUrlUsesRemaining) {
    const errorText = `This Slack slash reply is too large for the remaining response_url budget (${String(responseUrlUses)} responses needed; ${String(responseUrlUsesRemaining)} available). Send the result as a regular message instead.`;
    responseUrlBudget.closed = true;
    if (params.messageSentHookTarget) {
      emitSlackMessageSentHooks({
        sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
        to: params.messageSentHookTarget,
        accountId: params.accountId,
        content: plannedDeliveries
          .map((delivery) => delivery.hookContent)
          .filter(Boolean)
          .join("\n"),
        success: false,
        error: errorText,
        isGroup: params.isGroup,
        groupId: params.groupId,
      });
    }
    if (responseUrlUsesRemaining > 0) {
      responseUrlBudget.used += 1;
      await params.respond({ text: errorText, response_type: responseType });
    }
    return;
  }

  const respond = async (message: Parameters<SlackRespondFn>[0]) => {
    responseUrlBudget.used += 1;
    return await params.respond(message);
  };

  // Slack slash command responses can be multi-part by sending follow-ups via response_url.
  for (const delivery of plannedDeliveries) {
    try {
      for (const message of delivery.messages) {
        const hasNativeData = hasSlackNativeDataBlock(message.blocks);
        const outboundMessage: SlackSlashReplyWireMessage = {
          text: message.text,
          ...(message.blocks?.length ? { blocks: message.blocks } : {}),
        };
        try {
          const response = await respond({ ...outboundMessage, response_type: responseType });
          if (!hasNativeData || !isSlackInvalidBlocksError(response)) {
            continue;
          }
        } catch (error) {
          if (!hasNativeData || !isSlackInvalidBlocksError(error)) {
            throw error;
          }
        }
        const fallback = resolveSlackNativeDataFallback(message);
        if (!fallback) {
          throw new Error("Slack native-data fallback was unavailable");
        }
        const fallbackResponse = await respond({
          ...fallback.message,
          response_type: responseType,
        });
        if (isSlackInvalidBlocksError(fallbackResponse)) {
          throw fallbackResponse;
        }
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
