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
import { buildSlackBlocksFallbackText } from "../blocks-fallback.js";
import { markdownToSlackMrkdwnChunks } from "../format.js";
import { SLACK_TEXT_LIMIT } from "../limits.js";
import { emitSlackMessageSentHooks } from "../message-sent-hook.js";
import {
  buildSlackNativeDataAccessibilityText,
  hasSlackNativeDataBlock,
  isSlackInvalidBlocksError,
} from "../native-data-blocks.js";
import {
  buildSlackNativeDataDeliveryPlan,
  chunkSlackTextAtHardLimit,
  type SlackFormattingDisabledMessage,
} from "../native-data-fallback.js";
import {
  hasSlackReplyStructuredContent,
  resolveSlackReplyBlockResolution,
  resolveSlackReplyBlocks,
} from "../reply-blocks.js";
import type { SlackEventScope } from "./event-scope.js";
import {
  createSlackResponseUrlBudget,
  SlackResponseAlreadyReportedError,
  type SlackResponseUrlBudget as ResponseUrlBudget,
} from "./response-url-budget.js";
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
    authoredTextPlacement?: "none" | "blocks" | "outside-blocks";
    nativeDataFallbackBaseText?: string;
    textIsSlackMrkdwn?: boolean;
    textIsSlackPlainText?: boolean;
  }): Promise<SlackSendResult> => {
    return await sendMessageSlack(params.target, input.text, {
      cfg: params.cfg,
      token: params.token,
      threadTs: input.threadTs,
      accountId: params.accountId,
      ...(input.mediaUrl ? { mediaUrl: input.mediaUrl } : {}),
      ...(input.blocks ? { blocks: input.blocks } : {}),
      ...(input.authoredTextPlacement
        ? { authoredTextPlacement: input.authoredTextPlacement }
        : {}),
      ...(Object.hasOwn(input, "nativeDataFallbackBaseText")
        ? { nativeDataFallbackBaseText: input.nativeDataFallbackBaseText }
        : {}),
      ...(input.textIsSlackMrkdwn ? { textIsSlackMrkdwn: true } : {}),
      ...(input.textIsSlackPlainText ? { textIsSlackPlainText: true } : {}),
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
    const textRaw =
      reply.hasText && !isSilentReplyText(reply.trimmedText, SILENT_REPLY_TOKEN)
        ? reply.trimmedText
        : undefined;
    const materializeAuthoredText = !reply.hasMedia && hasSlackReplyStructuredContent(payload);
    const { authoredTextPlacement, segments } = resolveSlackReplyBlockResolution(payload, {
      materializeAuthoredText,
    });
    if (!textRaw && !reply.hasMedia && segments.length === 0) {
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

    const spokenText = resolveSlackMediaHookSpokenText(payload);
    const hookParts: string[] = [];
    let outsideText = authoredTextPlacement === "outside-blocks" ? (textRaw ?? "") : "";
    let lastResult: SlackSendResult | undefined;
    let delivered = false;
    try {
      if (reply.hasMedia) {
        const mediaCaption = outsideText;
        if (mediaCaption) {
          hookParts.push(mediaCaption);
          outsideText = "";
        } else if (!textRaw && spokenText) {
          hookParts.push(spokenText);
        }
        const mediaDelivery = await deliverTextOrMediaReply({
          payload,
          text: mediaCaption,
          sendText: async (text) => {
            lastResult = await sendReply({ text, threadTs });
          },
          sendMedia: async ({ mediaUrl, caption }) => {
            lastResult = await sendReply({ text: caption ?? "", mediaUrl, threadTs });
          },
        });
        delivered ||= mediaDelivery !== "empty";
      }

      for (const segment of segments) {
        if (segment.kind === "text") {
          const text = [outsideText, segment.text].filter(Boolean).join("\n\n");
          outsideText = "";
          if (!text) {
            continue;
          }
          hookParts.push(text);
          for (const chunk of chunkSlackTextAtHardLimit(text)) {
            lastResult = await sendReply({ text: chunk, threadTs, textIsSlackPlainText: true });
            delivered = true;
          }
          continue;
        }
        const baseText = outsideText;
        outsideText = "";
        const accessibilityText =
          buildSlackNativeDataAccessibilityText(baseText, segment.blocks) ||
          buildSlackBlocksFallbackText(segment.blocks);
        hookParts.push(accessibilityText);
        const segmentPlacement = baseText
          ? "outside-blocks"
          : authoredTextPlacement === "blocks"
            ? "blocks"
            : "none";
        lastResult = await sendReply({
          text: baseText,
          threadTs,
          blocks: segment.blocks,
          authoredTextPlacement: segmentPlacement,
          ...(baseText ? { nativeDataFallbackBaseText: baseText } : {}),
        });
        delivered = true;
      }

      if (outsideText && !reply.hasMedia) {
        hookParts.push(outsideText);
        lastResult = await sendReply({ text: outsideText, threadTs });
        delivered = true;
      }
    } catch (error) {
      const hookContent = hookParts.join("\n\n") || textRaw || spokenText || "";
      emitFailed(hookContent, error);
      throw error;
    }
    if (delivered) {
      const hookContent = hookParts.join("\n\n") || textRaw || spokenText || "";
      // Preserve the media hook contract even when a trailing block send has a
      // message `ts`; the logical payload still spans multiple Slack objects.
      emitSent(hookContent, reply.hasMedia ? undefined : lastResult);
      latestResult = lastResult;
      params.runtime.log?.(`delivered reply to ${params.target}`);
    }
  }
  return latestResult;
}

type SlackRespondFn = (payload: {
  text: string;
  blocks?: (Block | KnownBlock)[];
  mrkdwn?: false;
  response_type?: "ephemeral" | "in_channel";
}) => Promise<unknown>;

type SlackResponseUrlBudget = ResponseUrlBudget<Parameters<SlackRespondFn>[0]>;

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
  responseBudget?: SlackResponseUrlBudget;
}) {
  type SlashReplyMessage = {
    text: string;
    blocks?: (Block | KnownBlock)[];
    mrkdwn?: false;
  };
  type PlannedSlashReplyMessage = {
    message: SlashReplyMessage;
    nativeFallback?: SlackFormattingDisabledMessage[];
    skipOriginalBlocks?: true;
  };
  type SlashReplyDelivery = {
    hookContent: string;
    messages: PlannedSlashReplyMessage[];
  };
  const deliveries: SlashReplyDelivery[] = [];
  const responseBudget = params.responseBudget ?? createSlackResponseUrlBudget(params.respond);
  const chunkLimit = Math.max(1, Math.min(params.textLimit, SLACK_TEXT_LIMIT));
  const createBlockMessagePlan = (input: {
    blocks: NonNullable<ReturnType<typeof readSlackReplyBlocks>>;
    baseText?: string;
  }): PlannedSlashReplyMessage => {
    const plan = buildSlackNativeDataDeliveryPlan({
      blocks: input.blocks,
      baseText: input.baseText,
    });
    return {
      message: {
        text: plan.accessibilityText,
        blocks: input.blocks,
        mrkdwn: false,
      },
      nativeFallback: plan.fallbackMessages,
      ...(plan.skipOriginalBlocks ? { skipOriginalBlocks: true as const } : {}),
    };
  };

  for (const payload of params.replies) {
    if (payload.isReasoning === true) {
      continue;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    const textRaw =
      reply.hasText && !isSilentReplyText(reply.trimmedText, SILENT_REPLY_TOKEN)
        ? reply.trimmedText
        : undefined;
    const materializeAuthoredText = hasSlackReplyStructuredContent(payload);
    const { authoredTextPlacement, segments } = resolveSlackReplyBlockResolution(payload, {
      materializeAuthoredText,
    });
    let outsideText = authoredTextPlacement === "outside-blocks" ? (textRaw ?? "") : "";
    const messages: PlannedSlashReplyMessage[] = [];
    const hookParts: string[] = [];
    for (const segment of segments) {
      if (segment.kind === "text") {
        const text = [outsideText, segment.text].filter(Boolean).join("\n\n");
        outsideText = "";
        if (text) {
          hookParts.push(text);
          messages.push(
            ...chunkSlackTextAtHardLimit(text).map(
              (chunk): PlannedSlashReplyMessage => ({
                message: { text: chunk, mrkdwn: false },
              }),
            ),
          );
        }
        continue;
      }
      const baseText = outsideText;
      outsideText = "";
      const accessibilityText =
        buildSlackNativeDataAccessibilityText(baseText, segment.blocks) ||
        buildSlackBlocksFallbackText(segment.blocks);
      hookParts.push(accessibilityText);
      const blockPlan = createBlockMessagePlan({ blocks: segment.blocks, baseText });
      messages.push(
        hasSlackNativeDataBlock(segment.blocks) || blockPlan.skipOriginalBlocks
          ? blockPlan
          : {
              message: {
                text: accessibilityText,
                blocks: segment.blocks,
                mrkdwn: false,
              },
            },
      );
    }
    if (outsideText) {
      hookParts.push(outsideText);
    }
    if (reply.mediaUrls.length > 0) {
      hookParts.push(...reply.mediaUrls);
    }

    if (segments.length > 0) {
      const trailingText = [outsideText, ...reply.mediaUrls].filter(Boolean).join("\n");
      if (trailingText) {
        messages.push(
          ...chunkSlackTextAtHardLimit(trailingText).map(
            (text): PlannedSlashReplyMessage => ({ message: { text, mrkdwn: false } }),
          ),
        );
      }
      if (messages.length > 0) {
        deliveries.push({ hookContent: hookParts.filter(Boolean).join("\n\n"), messages });
      }
      continue;
    }

    const combined = [textRaw ?? "", ...reply.mediaUrls].filter(Boolean).join("\n");
    if (!combined) {
      continue;
    }
    const chunkMode = params.chunkMode ?? "length";
    const chunks = (
      chunkMode === "newline"
        ? chunkMarkdownTextWithMode(combined, chunkLimit, chunkMode)
        : [combined]
    ).flatMap((markdown) =>
      markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode: params.tableMode }),
    );
    deliveries.push({
      hookContent: textRaw ?? resolveSlackMediaHookSpokenText(payload) ?? combined,
      messages: (chunks.length > 0 ? chunks : [combined]).map((text) => ({ message: { text } })),
    });
  }

  if (deliveries.length === 0) {
    return;
  }

  // Slack slash command responses can be multi-part by sending follow-ups via response_url.
  const responseType = params.ephemeral ? "ephemeral" : "in_channel";
  const respond = async (message: SlashReplyMessage) =>
    await responseBudget.respond({
      text: message.text,
      response_type: responseType,
      ...(message.blocks ? { blocks: message.blocks } : {}),
      ...(message.mrkdwn === false ? { mrkdwn: false as const } : {}),
    });
  const emitDeliveryFailure = (delivery: SlashReplyDelivery, error: unknown) => {
    if (!params.messageSentHookTarget) {
      return;
    }
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
  };

  const plannedMessages = deliveries.flatMap((delivery) => delivery.messages);
  const minimumCalls = plannedMessages.map((planned) => planned.nativeFallback?.length ?? 1);
  const minimumRemainingCalls = Array.from({ length: minimumCalls.length + 1 }, () => 0);
  for (let index = minimumCalls.length - 1; index >= 0; index -= 1) {
    minimumRemainingCalls[index] =
      (minimumRemainingCalls[index + 1] ?? 0) + (minimumCalls[index] ?? 0);
  }
  const failOversizedDelivery = async (): Promise<never> => {
    const message = "Slack response exceeds the remaining response_url delivery budget.";
    let failure: unknown = new Error(message);
    if (responseBudget.remaining() !== 0) {
      try {
        await responseBudget.respond({
          text: "This Slack response is too large to deliver within the remaining response window.",
          response_type: "ephemeral",
        });
        failure = new SlackResponseAlreadyReportedError(message);
      } catch (error) {
        failure = error;
      }
    }
    for (const delivery of deliveries) {
      emitDeliveryFailure(delivery, failure);
    }
    throw failure;
  };
  const initialRemaining = responseBudget.remaining();
  const initialMinimumCalls = minimumCalls.reduce((total, calls) => total + calls, 0);
  if (initialRemaining !== undefined && initialMinimumCalls > initialRemaining) {
    await failOversizedDelivery();
  }

  const deliverNativeFallback = async (messages: readonly SlackFormattingDisabledMessage[]) => {
    for (const message of messages) {
      const response = await respond(message);
      if (isSlackInvalidBlocksError(response)) {
        throw new Error("Slack rejected the native-data fallback blocks with invalid_blocks.");
      }
    }
  };

  let plannedIndex = 0;
  for (const delivery of deliveries) {
    try {
      for (const planned of delivery.messages) {
        const minimumAfter = minimumRemainingCalls[plannedIndex + 1] ?? 0;
        plannedIndex += 1;
        const fallback = planned.nativeFallback;
        if (!fallback) {
          await respond(planned.message);
          continue;
        }
        const remaining = responseBudget.remaining();
        const canAttemptNative =
          !planned.skipOriginalBlocks &&
          (remaining === undefined || 1 + fallback.length + minimumAfter <= remaining);
        if (!canAttemptNative) {
          await deliverNativeFallback(fallback);
          continue;
        }
        let rejectedNativeBlocks = false;
        try {
          const response = await respond(planned.message);
          rejectedNativeBlocks = isSlackInvalidBlocksError(response);
        } catch (error) {
          if (!isSlackInvalidBlocksError(error)) {
            throw error;
          }
          rejectedNativeBlocks = true;
        }
        if (rejectedNativeBlocks) {
          await deliverNativeFallback(fallback);
        }
      }
    } catch (error) {
      emitDeliveryFailure(delivery, error);
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
