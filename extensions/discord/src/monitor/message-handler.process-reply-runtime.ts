// Discord plugin module owns the reply pipeline, draft preview, and delivery correlation setup.
import {
  createChannelMessageReplyPipeline,
  resolveChannelStreamingBlockEnabled,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { resolveChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { readLatestAssistantTextByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import { beginDiscordInboundEventDeliveryCorrelation } from "../inbound-event-delivery.js";
import type { RequestClient } from "../internal/discord.js";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import { createDiscordDraftPreviewController } from "./message-handler.draft-preview.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import { createDiscordReplyTypingFeedback } from "./reply-typing-feedback.js";

type DiscordMessageProcessContext = NonNullable<
  Awaited<ReturnType<typeof buildDiscordMessageProcessContext>>
>;

export function createDiscordMessageReplyRuntime(params: {
  ctx: DiscordMessagePreflightContext;
  processContext: DiscordMessageProcessContext;
  sourceRepliesAreToolOnly: boolean;
  shouldDisableCoreTypingKeepalive: boolean;
  isRoomEvent: boolean;
  dispatchStartedAt: number;
  feedbackRest: RequestClient;
  deliveryRest: RequestClient;
}) {
  const { ctx, processContext } = params;
  const {
    cfg,
    discordConfig,
    accountId,
    token,
    guildHistories,
    historyLimit,
    textLimit,
    messageChannelId,
    isDirectMessage,
    route,
  } = ctx;
  const { ctxPayload, deliverTarget, replyReference } = processContext;
  const typingChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : messageChannelId;
  let typingFeedback: ReturnType<typeof createDiscordReplyTypingFeedback> | undefined;
  const getTypingFeedback = () =>
    (typingFeedback ??= createDiscordReplyTypingFeedback({
      cfg,
      token,
      accountId,
      channelId: typingChannelId,
      rest: params.feedbackRest,
      log: logVerbose,
      keepaliveIntervalMs: params.shouldDisableCoreTypingKeepalive ? undefined : 0,
    }));

  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: "discord",
    accountId: route.accountId,
    // The core lifecycle reaches this callback only after reply admission.
    // Silent pre-dispatch outcomes therefore never allocate or emit feedback.
    typingCallbacks: {
      onReplyStart: () => getTypingFeedback().onReplyStart(),
      onIdle: () => typingFeedback?.onIdle?.(),
      onCleanup: () => typingFeedback?.onCleanup?.(),
    },
  });
  const tableMode = resolveMarkdownTableMode({ cfg, channel: "discord", accountId });
  const maxLinesPerMessage = resolveDiscordMaxLinesPerMessage({
    cfg,
    discordConfig,
    accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "discord", accountId);
  const clearGroupHistory = () => {
    if (isDirectMessage) {
      return;
    }
    createChannelHistoryWindow({ historyMap: guildHistories }).clear({
      historyKey: messageChannelId,
      limit: historyLimit,
    });
  };
  const beginDeliveryCorrelation = () =>
    params.isRoomEvent
      ? beginDiscordInboundEventDeliveryCorrelation(
          ctxPayload.SessionKey,
          {
            outboundTo: messageChannelId,
            outboundAccountId: route.accountId,
            markInboundEventDelivered: clearGroupHistory,
          },
          { inboundEventKind: ctxPayload.InboundEventKind },
        )
      : () => {};
  const endDeliveryCorrelation = beginDeliveryCorrelation();

  const resolveCurrentTurnTranscriptFinalText = async (): Promise<string | undefined> => {
    const sessionKey = ctxPayload.SessionKey;
    if (!sessionKey) {
      return undefined;
    }
    try {
      const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
      const sessionEntry = getSessionEntry({
        agentId: route.agentId,
        sessionKey,
        storePath,
      });
      if (!sessionEntry?.sessionId) {
        return undefined;
      }
      const latest = await readLatestAssistantTextByIdentity({
        agentId: route.agentId,
        sessionId: sessionEntry.sessionId,
        sessionKey,
        storePath,
      });
      if (!latest?.timestamp || latest.timestamp < params.dispatchStartedAt) {
        return undefined;
      }
      return latest.text;
    } catch (err) {
      logVerbose(`discord transcript final candidate lookup failed: ${String(err)}`);
      return undefined;
    }
  };

  const deliverChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : messageChannelId;
  const draftPreview = createDiscordDraftPreviewController({
    cfg,
    discordConfig,
    accountId,
    sourceRepliesAreToolOnly: params.sourceRepliesAreToolOnly,
    textLimit,
    deliveryRest: params.deliveryRest,
    deliverChannelId,
    replyReference,
    tableMode,
    maxLinesPerMessage,
    chunkMode,
    log: logVerbose,
  });
  const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(discordConfig);

  return {
    replyPipeline,
    onModelSelected,
    tableMode,
    maxLinesPerMessage,
    chunkMode,
    beginQueuedDeliveryCorrelation: beginDeliveryCorrelation,
    endDeliveryCorrelation,
    resolveCurrentTurnTranscriptFinalText,
    deliverChannelId,
    draftPreview,
    resolvedBlockStreamingEnabled,
  };
}
