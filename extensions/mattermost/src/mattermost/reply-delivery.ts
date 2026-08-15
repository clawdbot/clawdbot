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
import type {
  ReplyDispatchKind,
  ReplyFollowupAdmissionBarrierTimeoutPolicy,
  ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
import {
  resolveMattermostReplyDeliveryBarrierTimeoutMs,
  type CreateDmChannelRetryOptions,
} from "./client.js";
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
    replyToId?: string;
    onDmChannelResolution?: (resolution: PromiseLike<unknown>) => void;
  },
) => Promise<MattermostSendResult>;

export function createMattermostReplyDeliveryBarrier(params: {
  isDirect: boolean;
  dmRetryOptions?: CreateDmChannelRetryOptions;
}) {
  let activeDmChannelResolutions = 0;
  let queuedDeliveryCount = 0;
  let settledDeliveryCount = 0;
  const trackDmChannelResolution = (resolution: PromiseLike<unknown>) => {
    activeDmChannelResolutions += 1;
    void Promise.resolve(resolution).then(
      () => {
        activeDmChannelResolutions -= 1;
      },
      () => {
        activeDmChannelResolutions -= 1;
      },
    );
  };
  const markDeliverySettled = () => {
    settledDeliveryCount += 1;
  };
  const resolveTimeoutPolicy = (context: {
    queuedCounts: Readonly<Record<ReplyDispatchKind, number>>;
    humanDelayBudgetMs: number;
  }): ReplyFollowupAdmissionBarrierTimeoutPolicy | undefined => {
    const { queuedCounts } = context;
    queuedDeliveryCount = Object.values(queuedCounts).reduce((sum, count) => sum + count, 0);
    const maxTimeoutMs = resolveMattermostReplyDeliveryBarrierTimeoutMs({
      isDirect: params.isDirect,
      dmRetryOptions: params.dmRetryOptions,
      queuedCounts,
      humanDelayBudgetMs: context.humanDelayBudgetMs,
    });
    if (maxTimeoutMs === undefined) {
      return undefined;
    }
    return {
      maxTimeoutMs,
      shouldExtend: () =>
        activeDmChannelResolutions > 0 || settledDeliveryCount < queuedDeliveryCount,
    };
  };
  return {
    trackDmChannelResolution,
    markDeliverySettled,
    resolveTimeoutPolicy,
  };
}

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
  to: string;
  accountId: string;
  agentId?: string;
  replyToId?: string;
  textLimit: number;
  tableMode: MarkdownTableMode;
  sendMessage: SendMattermostMessage;
  onDmChannelResolution?: (resolution: PromiseLike<unknown>) => void;
}): Promise<MattermostReplyDeliveryResult> {
  if (isReasoningReplyPayload(params.payload)) {
    return {
      outcome: "reasoning_skipped",
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    };
  }
  const reply = resolveSendableOutboundReplyParts(params.payload, {
    text: params.core.channel.text.convertMarkdownTables(
      params.payload.text ?? "",
      params.tableMode,
    ),
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.agentId);
  const chunkMode = params.core.channel.text.resolveChunkMode(
    params.cfg,
    "mattermost",
    params.accountId,
  );
  const results: MattermostSendResult[] = [];
  const acceptedContents: string[] = [];
  let outcome: Exclude<MattermostReplyDeliveryOutcome, "reasoning_skipped">;
  try {
    outcome = await deliverTextOrMediaReply({
      payload: params.payload,
      text: reply.text,
      chunkText: (value) =>
        params.core.channel.text.chunkMarkdownTextWithMode(value, params.textLimit, chunkMode),
      sendText: async (chunk) => {
        const result = await params.sendMessage(params.to, chunk, {
          cfg: params.cfg,
          accountId: params.accountId,
          replyToId: params.replyToId,
          ...(params.onDmChannelResolution
            ? { onDmChannelResolution: params.onDmChannelResolution }
            : {}),
        });
        results.push(result);
        acceptedContents.push(result.content);
      },
      sendMedia: async ({ mediaUrl, caption }) => {
        const result = await params.sendMessage(params.to, caption ?? "", {
          cfg: params.cfg,
          accountId: params.accountId,
          mediaUrl,
          mediaLocalRoots,
          replyToId: params.replyToId,
          ...(params.onDmChannelResolution
            ? { onDmChannelResolution: params.onDmChannelResolution }
            : {}),
        });
        results.push(result);
        acceptedContents.push(result.content);
      },
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
