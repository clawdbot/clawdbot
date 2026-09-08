// Delivers ACP turn results through reply payload routing.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  buildCaptionedFinalTextFallback,
  cleanDeferredFinalText,
  isCaptionedFinalTextPayload,
  mergeDeferredFinalText,
} from "../../tts/captioned-final.js";
import { createTtsDirectiveTextStreamCleaner } from "../../tts/directives.js";
import { shouldCleanTtsDirectiveText } from "../../tts/tts-config.js";
import {
  copyReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  isReplyPayloadTtsSupplement,
} from "../reply-payload.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { maybeApplyAcpTts, prepareAcpDeliveryPayload } from "./dispatch-acp-payload.js";
import type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";
import {
  resolveRoutedReplyDeliveryOutcome,
  shouldRetryReplyDispatch,
} from "./reply-dispatch-outcome.js";
import {
  attachReplyDispatchUndeliveredFallback,
  captureReplyDispatchDeliveryOutcome,
  waitForReplyDispatcherIdle,
} from "./reply-dispatcher.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";
import {
  createReplyDeliveryContext,
  resolveReplyDeliveryAccountId,
  resolveReplyToMode,
} from "./reply-threading.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";

const routeReplyRuntimeLoader = createLazyImportLoader(() => import("./route-reply.runtime.js"));
const channelPluginRuntimeLoader = createLazyImportLoader(
  () => import("../../channels/plugins/index.js"),
);
const messageActionRuntimeLoader = createLazyImportLoader(
  () => import("../../infra/outbound/message-action-runner.js"),
);

type AcpDispatchDeliveryMeta = {
  toolCallId?: string;
  allowEdit?: boolean;
  skipTts?: boolean;
  /** Transport-only finals retain their runtime source instead of adding final text. */
  transcriptSource?: { kind: "blocks" | "fallback" } | { kind: "final"; text: string };
};

type ToolMessageHandle = {
  channel: string;
  accountId?: string;
  to: string;
  threadId?: string | number;
  messageId: string;
};

async function shouldTreatDeliveredTextAsVisible(params: {
  channel: string | undefined;
  kind: ReplyDispatchKind;
  text: string | undefined;
}): Promise<boolean> {
  if (!normalizeOptionalString(params.text)) {
    return false;
  }
  if (params.kind === "final") {
    return true;
  }
  const channelId = normalizeOptionalLowercaseString(params.channel);
  if (!channelId) {
    return false;
  }
  const { getChannelPlugin } = await channelPluginRuntimeLoader.load();
  const outbound = getChannelPlugin(channelId)?.outbound;
  const visibilityOverride =
    outbound?.shouldTreatDeliveredTextAsVisible ?? outbound?.shouldTreatRoutedTextAsVisible;
  if (visibilityOverride) {
    return visibilityOverride({
      kind: params.kind,
      text: params.text,
    });
  }
  return false;
}

type AcpBlockText = {
  text: string;
  transcriptText?: string;
  needsFinalDelivery: boolean;
  // A terminal-only surface can confirm a block yet still need final delivery.
  delivered?: true;
};

type AcpDispatchDeliveryState = {
  startedReplyLifecycle: boolean;
  blockTexts: AcpBlockText[];
  accumulatedBlockTtsText: string;
  accumulatedFinalText: string;
  accumulatedDeliveredFinalText: string;
  pendingTranscriptOutcomes: Promise<void>[];
  cleanBlockTtsDirectiveText?: ReturnType<typeof createTtsDirectiveTextStreamCleaner>;
  deliveredFinalReply: boolean;
  pendingAnswerDelivery: boolean;
  pendingFinalTtsMedia: boolean;
  deliveredAnswerFinalToUser: boolean;
  deliveredFinalTtsMedia: boolean;
  deliveredVisibleText: boolean;
  failedVisibleTextDelivery: boolean;
  queuedUntrackedVisibleTextDeliveries: number;
  settledUntrackedVisibleText: boolean;
  routedCounts: Record<ReplyDispatchKind, number>;
  suppressionReason?: NormalizeReplySkipReason;
  toolMessageByCallId: Map<string, ToolMessageHandle>;
};

export type AcpDispatchDeliveryCoordinator = ReturnType<
  typeof createAcpDispatchDeliveryCoordinator
>;

export function createAcpDispatchDeliveryCoordinator(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  ctx: FinalizedMsgContext;
  dispatcher: ReplyDispatcher;
  inboundAudio: boolean;
  sessionKey?: string;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  suppressUserDelivery?: boolean;
  suppressBlockUserDelivery?: boolean;
  suppressReplyLifecycle?: boolean;
  shouldRouteToOriginating: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string | number;
  originatingChatType?: ChatType;
  onReplyStart?: () => Promise<void> | void;
  abortSignal?: AbortSignal;
  runId?: string;
}) {
  const directChannel = normalizeOptionalLowercaseString(params.ctx.Provider ?? params.ctx.Surface);
  const routedChannel = normalizeOptionalLowercaseString(params.originatingChannel);
  const deliverySessionKey = normalizeOptionalString(params.sessionKey) ?? params.ctx.SessionKey;
  const explicitAccountId =
    normalizeOptionalString(params.originatingAccountId) ??
    normalizeOptionalString(params.ctx.AccountId);
  const resolvedAccountId = resolveReplyDeliveryAccountId(
    params.cfg,
    routedChannel ?? directChannel,
    explicitAccountId,
  );
  const routedReplyDelivery = params.originatingChannel
    ? createReplyDeliveryContext(
        resolveReplyToMode(
          params.cfg,
          params.originatingChannel,
          resolvedAccountId,
          params.originatingChatType ?? params.ctx.ChatType,
        ),
        params.originatingChatType ?? params.ctx.ChatType,
      )
    : undefined;
  const state: AcpDispatchDeliveryState = {
    startedReplyLifecycle: false,
    blockTexts: [],
    accumulatedBlockTtsText: "",
    accumulatedFinalText: "",
    accumulatedDeliveredFinalText: "",
    pendingTranscriptOutcomes: [],
    cleanBlockTtsDirectiveText: shouldCleanTtsDirectiveText({
      cfg: params.cfg,
      ttsAuto: params.sessionTtsAuto,
      agentId: params.agentId,
      channelId: params.ttsChannel,
      accountId: resolvedAccountId,
    })
      ? createTtsDirectiveTextStreamCleaner()
      : undefined,
    deliveredFinalReply: false,
    pendingAnswerDelivery: false,
    pendingFinalTtsMedia: false,
    deliveredAnswerFinalToUser: false,
    deliveredFinalTtsMedia: false,
    deliveredVisibleText: false,
    failedVisibleTextDelivery: false,
    queuedUntrackedVisibleTextDeliveries: 0,
    settledUntrackedVisibleText: false,
    routedCounts: {
      tool: 0,
      block: 0,
      final: 0,
    },
    suppressionReason: undefined,
    toolMessageByCallId: new Map(),
  };
  let hasPendingDirectBlockReplyDelivery = false;

  const settleDirectVisibleText = async () => {
    // Exact payload settlements own custody and coverage before final fallback reads them.
    await waitForReplyDispatcherIdle(
      {
        waitForIdle: async () => {
          await Promise.all(state.pendingTranscriptOutcomes);
        },
      },
      params.abortSignal,
    );
    if (params.abortSignal?.aborted) {
      return;
    }
    hasPendingDirectBlockReplyDelivery = false;
    if (state.settledUntrackedVisibleText || state.queuedUntrackedVisibleTextDeliveries === 0) {
      return;
    }
    state.settledUntrackedVisibleText = true;
    const receipt = await waitForReplyDispatcherIdle(params.dispatcher, params.abortSignal);
    if (!receipt) {
      return;
    }
    const visibleCounts = [receipt.counts.block, receipt.counts.final];
    state.failedVisibleTextDelivery ||= visibleCounts.some(
      (counts) => counts.failedBeforeSend + counts.failedAfterSend > 0,
    );
    state.deliveredVisibleText ||= visibleCounts.some(
      (counts) => counts.delivered + counts.failedAfterSend > 0,
    );
  };

  const startReplyLifecycleOnce = async () => {
    if (state.startedReplyLifecycle) {
      return;
    }
    state.startedReplyLifecycle = true;
    // Delivery and lifecycle suppression are separate: message-tool-only turns
    // suppress automatic user delivery but still need typing/lifecycle signals.
    if (params.suppressReplyLifecycle) {
      return;
    }
    void Promise.resolve(params.onReplyStart?.()).catch((error: unknown) => {
      logVerbose(`dispatch-acp: reply lifecycle start failed: ${formatErrorMessage(error)}`);
    });
  };

  const tryEditToolMessage = async (
    payload: ReplyPayload,
    toolCallId: string,
  ): Promise<boolean> => {
    const handle = state.toolMessageByCallId.get(toolCallId);
    if (!handle?.messageId) {
      return false;
    }
    const message = normalizeOptionalString(payload.text);
    if (!message) {
      return false;
    }

    try {
      const { runMessageAction } = await messageActionRuntimeLoader.load();
      await runMessageAction({
        cfg: params.cfg,
        action: "edit",
        params: {
          channel: handle.channel,
          to: handle.to,
          threadId: handle.threadId,
          messageId: handle.messageId,
          message,
        },
        defaultAccountId: handle.accountId,
        sessionKey: params.ctx.SessionKey,
        requesterAccountId: params.ctx.AccountId,
      });
      state.routedCounts.tool += 1;
      return true;
    } catch (error) {
      logVerbose(
        `dispatch-acp: tool message edit failed for ${toolCallId}: ${formatErrorMessage(error)}`,
      );
      return false;
    }
  };

  const deliver = async (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    meta?: AcpDispatchDeliveryMeta,
  ): Promise<boolean> => {
    const transcriptSource = meta?.transcriptSource;
    // Snapshot coverage before preparation/TTS can yield to another payload.
    const coveredBlocks =
      kind === "final"
        ? state.blockTexts.filter(
            (block) => transcriptSource?.kind === "blocks" || block.needsFinalDelivery,
          )
        : [];
    const coverFinalBlockText = (source: ReplyPayload) => {
      if (
        !source.text?.trim() ||
        source.isCommentary ||
        source.isReasoning ||
        isReplyPayloadStatusNotice(source)
      ) {
        return;
      }
      for (const block of coveredBlocks) {
        block.needsFinalDelivery = false;
      }
    };
    let visiblePayload = payload;
    if (!params.suppressUserDelivery) {
      const routed = params.shouldRouteToOriginating && routedChannel !== undefined;
      const messaging = routed
        ? (await channelPluginRuntimeLoader.load()).getChannelPlugin(routedChannel)?.messaging
        : undefined;
      const prepared = prepareAcpDeliveryPayload({
        cfg: params.cfg,
        dispatcher: params.dispatcher,
        kind,
        payload,
        routed,
        ...(messaging ? { messaging } : {}),
        accountId: resolvedAccountId,
      });
      if (prepared.kind === "suppress") {
        if (prepared.reason === "channel_transform") {
          state.suppressionReason = prepared.reason;
          coverFinalBlockText(payload);
        }
        return false;
      }
      visiblePayload = prepared.payload;
    }
    const isStatusNotice = isReplyPayloadStatusNotice(visiblePayload);
    const rawBlockPayloadText =
      kind === "block" ? normalizeOptionalString(visiblePayload.text) : undefined;
    const rawBlockText = isStatusNotice ? undefined : rawBlockPayloadText;
    let blockText: AcpBlockText | undefined;
    if (rawBlockPayloadText) {
      const joinsBufferedTtsDirective =
        state.cleanBlockTtsDirectiveText?.hasBufferedDirectiveText() === true;
      if (rawBlockText) {
        if (state.accumulatedBlockTtsText.length > 0 && !joinsBufferedTtsDirective) {
          state.accumulatedBlockTtsText += "\n";
        }
        state.accumulatedBlockTtsText += rawBlockText;
      }

      if (state.cleanBlockTtsDirectiveText && rawBlockText) {
        const text = state.cleanBlockTtsDirectiveText.push(rawBlockPayloadText);
        visiblePayload = copyReplyPayloadMetadata(visiblePayload, {
          ...visiblePayload,
          text: text.trim() ? text : undefined,
        });
      }
      if (visiblePayload.text || rawBlockText) {
        blockText = {
          text: visiblePayload.text ?? "",
          transcriptText: rawBlockText,
          needsFinalDelivery: Boolean(visiblePayload.text),
        };
        state.blockTexts.push(blockText);
      }
    }
    const rawFinalText =
      kind === "final" && !isStatusNotice
        ? normalizeOptionalString(visiblePayload.text)
        : undefined;
    if (rawFinalText && !transcriptSource) {
      if (state.accumulatedFinalText.length > 0) {
        state.accumulatedFinalText += "\n";
      }
      state.accumulatedFinalText += rawFinalText;
    }
    const transcriptFinalText = !transcriptSource
      ? rawFinalText
      : transcriptSource.kind === "final"
        ? transcriptSource.text
        : undefined;

    if (!hasOutboundReplyContent(visiblePayload, { trimText: true })) {
      return false;
    }
    await startReplyLifecycleOnce();

    if (params.suppressUserDelivery) {
      return false;
    }
    if (
      kind === "block" &&
      params.suppressBlockUserDelivery &&
      !isStatusNotice &&
      !visiblePayload.isReasoning &&
      !visiblePayload.isCommentary
    ) {
      const hasNonTextContent = Boolean(
        visiblePayload.mediaUrl ||
        visiblePayload.mediaUrls?.length ||
        visiblePayload.presentation ||
        visiblePayload.interactive ||
        visiblePayload.channelData,
      );
      if (!hasNonTextContent) {
        return false;
      }
      visiblePayload = copyReplyPayloadMetadata(visiblePayload, {
        ...visiblePayload,
        text: undefined,
      });
    }

    const appliedTtsPayload = await maybeApplyAcpTts({
      payload: visiblePayload,
      cfg: params.cfg,
      agentId: params.agentId,
      channel: params.ttsChannel,
      accountId: resolvedAccountId,
      kind,
      inboundAudio: params.inboundAudio,
      ttsAuto: params.sessionTtsAuto,
      skipTts: meta?.skipTts,
    });
    const finalVisibleTextSource =
      kind === "final" && params.suppressBlockUserDelivery && state.cleanBlockTtsDirectiveText
        ? meta?.skipTts || visiblePayload.isError || isReplyPayloadTtsSupplement(visiblePayload)
          ? visiblePayload.text
          : mergeDeferredFinalText(state.accumulatedBlockTtsText, visiblePayload.text)
        : undefined;
    const ttsPayload =
      finalVisibleTextSource !== undefined
        ? copyReplyPayloadMetadata(appliedTtsPayload, {
            ...appliedTtsPayload,
            text: cleanDeferredFinalText(finalVisibleTextSource) || undefined,
          })
        : appliedTtsPayload;
    const hasFinalTtsMedia = kind === "final" && isReplyPayloadTtsSupplement(ttsPayload);
    const isAnswerBearingFinal =
      kind === "final" &&
      (isCaptionedFinalTextPayload(visiblePayload) ||
        (hasFinalTtsMedia && Boolean(ttsPayload.text?.trim())));

    const recordPendingDelivery = (tracksVisibleText: boolean) => {
      if (blockText && tracksVisibleText) {
        blockText.needsFinalDelivery = false;
      }
      // Coverage belongs to this payload. Hidden text and independent final audio
      // remain deliverable, and commentary never stands in for an answer.
      const pendingAnswer =
        tracksVisibleText &&
        kind !== "tool" &&
        !isStatusNotice &&
        !ttsPayload.isCommentary &&
        !ttsPayload.isReasoning;
      state.pendingAnswerDelivery ||= pendingAnswer;
      coverFinalBlockText(ttsPayload);
      state.pendingFinalTtsMedia ||= hasFinalTtsMedia;
    };
    const recordFinalReply = () => {
      if (kind === "final") {
        state.deliveredFinalReply = true;
        // A generated final owns the answer; a block-derived send owns only its snapshot.
        state.deliveredAnswerFinalToUser ||=
          isAnswerBearingFinal && (!transcriptSource || transcriptSource.kind === "final");
        state.deliveredFinalTtsMedia ||= hasFinalTtsMedia;
        coverFinalBlockText(ttsPayload);
      }
    };
    const recordDeliveredReply = (tracksVisibleText: boolean) => {
      if (blockText) {
        blockText.delivered = true;
      }
      if (
        (rawFinalText || hasFinalTtsMedia) &&
        transcriptSource &&
        transcriptSource.kind !== "final"
      ) {
        for (const block of coveredBlocks) {
          block.delivered = true;
        }
      } else if (transcriptFinalText) {
        state.accumulatedDeliveredFinalText = state.accumulatedDeliveredFinalText
          ? `${state.accumulatedDeliveredFinalText}\n${transcriptFinalText}`
          : transcriptFinalText;
      }
      recordFinalReply();
      if (tracksVisibleText) {
        state.deliveredVisibleText = true;
        if (blockText) {
          blockText.needsFinalDelivery = false;
        }
      }
    };

    if (params.shouldRouteToOriginating && params.originatingChannel && params.originatingTo) {
      const toolCallId = normalizeOptionalString(meta?.toolCallId);
      if (kind === "tool" && meta?.allowEdit === true && toolCallId) {
        const edited = await tryEditToolMessage(ttsPayload, toolCallId);
        if (edited) {
          return true;
        }
      }

      const tracksVisibleText = await shouldTreatDeliveredTextAsVisible({
        channel: routedChannel,
        kind,
        text: ttsPayload.text,
      });
      const { routeReply } = await routeReplyRuntimeLoader.load();
      const threadId =
        params.originatingThreadId ??
        resolveRoutedDeliveryThreadId({
          ctx: params.ctx,
          sessionKey: deliverySessionKey,
        });
      const result = await routeReply({
        payload: ttsPayload,
        channel: params.originatingChannel,
        to: params.originatingTo,
        agentId: params.agentId,
        sessionKey: deliverySessionKey,
        ...(deliverySessionKey !== params.ctx.SessionKey
          ? { policySessionKey: params.ctx.SessionKey }
          : {}),
        accountId: resolvedAccountId,
        requesterSenderId: params.ctx.SenderId,
        requesterSenderName: params.ctx.SenderName,
        requesterSenderUsername: params.ctx.SenderUsername,
        requesterSenderE164: params.ctx.SenderE164,
        threadId,
        replyDelivery: routedReplyDelivery,
        cfg: params.cfg,
        abortSignal: params.abortSignal,
        mirror: false,
        replyKind: kind,
        runId: params.runId,
      });
      const outcome = resolveRoutedReplyDeliveryOutcome(result);
      const pending = outcome === "recovery-owned" || outcome === "failed-deliver";
      if (
        blockText &&
        result.suppressed &&
        (tracksVisibleText || (outcome === "channel-transform" && ttsPayload.text?.trim()))
      ) {
        // A channel veto covers its actual text even on a terminal-only surface.
        blockText.needsFinalDelivery = false;
      }
      if (pending) {
        recordPendingDelivery(tracksVisibleText);
        return true;
      }
      if (shouldRetryReplyDispatch(outcome) && hasFinalTtsMedia && ttsPayload.text?.trim()) {
        if (!result.suppressed) {
          logVerbose(
            `dispatch-acp: route-reply (acp/${kind}) failed: ${result.error ?? "unknown error"}`,
          );
        }
        return await deliver(
          "final",
          { text: ttsPayload.text },
          {
            skipTts: true,
            transcriptSource: transcriptSource ?? { kind: "final", text: rawFinalText ?? "" },
          },
        );
      }
      if (!result.delivered && !result.suppressed) {
        if (tracksVisibleText) {
          state.failedVisibleTextDelivery = true;
        }
        logVerbose(
          `dispatch-acp: route-reply (acp/${kind}) failed: ${result.error ?? "unknown error"}`,
        );
        return false;
      }
      if (result.suppressed) {
        if (outcome === "channel-transform") {
          coverFinalBlockText(ttsPayload);
        }
        if (kind === "final") {
          state.deliveredFinalReply = true;
        }
        if (tracksVisibleText) {
          state.deliveredVisibleText = true;
        }
        return true;
      }
      if (!result.ok) {
        logVerbose(
          `dispatch-acp: route-reply (acp/${kind}) partially failed after delivery: ${
            result.error ?? "unknown error"
          }`,
        );
      }
      if (kind === "tool" && meta?.toolCallId && result.messageId) {
        state.toolMessageByCallId.set(meta.toolCallId, {
          channel: params.originatingChannel,
          accountId: resolvedAccountId,
          to: params.originatingTo,
          ...(threadId != null ? { threadId } : {}),
          messageId: result.messageId,
        });
      }
      recordDeliveredReply(tracksVisibleText);
      state.routedCounts[kind] += 1;
      return true;
    }

    if (kind === "tool" && hasPendingDirectBlockReplyDelivery) {
      // Block admission stays non-blocking; a later tool cannot overtake its visible delivery.
      hasPendingDirectBlockReplyDelivery = false;
      await waitForReplyDispatcherIdle(params.dispatcher, params.abortSignal);
    }

    const tracksVisibleText = await shouldTreatDeliveredTextAsVisible({
      channel: directChannel,
      kind,
      text: ttsPayload.text,
    });
    const transcriptOutcome =
      kind !== "tool" ? captureReplyDispatchDeliveryOutcome(ttsPayload) : undefined;
    if (hasFinalTtsMedia && ttsPayload.text?.trim()) {
      attachReplyDispatchUndeliveredFallback(
        ttsPayload,
        buildCaptionedFinalTextFallback(ttsPayload),
      );
    }
    const delivered =
      kind === "tool"
        ? params.dispatcher.sendToolResult(ttsPayload)
        : kind === "block"
          ? params.dispatcher.sendBlockReply(ttsPayload)
          : params.dispatcher.sendFinalReply(ttsPayload);
    if (delivered && transcriptOutcome?.isTracked()) {
      const settlement = transcriptOutcome.promise.then((outcome) => {
        if (transcriptOutcome.hasPendingDelivery()) {
          recordPendingDelivery(tracksVisibleText);
        } else if (outcome === "delivered") {
          recordDeliveredReply(tracksVisibleText);
        } else {
          if (!shouldRetryReplyDispatch(outcome)) {
            // The dispatcher's terminal decision covers only text included in this attempt.
            if (blockText && ttsPayload.text?.trim()) {
              blockText.needsFinalDelivery = false;
            }
            coverFinalBlockText(ttsPayload);
          }
          if (tracksVisibleText) {
            state.failedVisibleTextDelivery ||=
              outcome === "failed-before-deliver" || outcome === "failed-deliver";
            state.deliveredVisibleText ||= outcome === "failed-deliver";
          }
        }
      });
      state.pendingTranscriptOutcomes.push(settlement);
      if (kind === "final") {
        // Outer dispatch races cancellation. This owner retains the admitted final
        // until its receipt can safely decide fallback and cancelled-turn history.
        await settlement;
      }
    } else if (delivered) {
      recordFinalReply();
      if (tracksVisibleText) {
        state.queuedUntrackedVisibleTextDeliveries += 1;
        state.settledUntrackedVisibleText = false;
      }
    } else if (!delivered && tracksVisibleText) {
      state.failedVisibleTextDelivery = true;
    }
    if (kind === "block" && delivered) {
      hasPendingDirectBlockReplyDelivery = true;
    }
    return delivered;
  };

  const getBlockTranscriptText = (confirmedOnly = false) =>
    state.blockTexts
      .flatMap((block) =>
        block.transcriptText && (!confirmedOnly || block.delivered) ? [block.transcriptText] : [],
      )
      .join("\n");

  return {
    startReplyLifecycle: startReplyLifecycleOnce,
    deliver,
    getAccumulatedVisibleBlockText: () =>
      state.blockTexts.flatMap((block) => (block.text ? [block.text] : [])).join("\n"),
    getBlockTextForFallback: () => {
      if (
        state.deliveredAnswerFinalToUser ||
        (!params.shouldRouteToOriginating &&
          state.queuedUntrackedVisibleTextDeliveries > 0 &&
          !params.suppressBlockUserDelivery &&
          state.deliveredVisibleText &&
          !state.failedVisibleTextDelivery)
      ) {
        return "";
      }
      const blocks = state.blockTexts.filter((block) => block.needsFinalDelivery);
      return params.suppressBlockUserDelivery && blocks.length > 0
        ? cleanDeferredFinalText(state.accumulatedBlockTtsText)
        : blocks.map((block) => block.text).join("\n");
    },
    getAccumulatedBlockTtsText: () => state.accumulatedBlockTtsText,
    getAccumulatedTranscriptText: () => state.accumulatedFinalText || getBlockTranscriptText(),
    resolveAccumulatedDeliveredTranscriptText: async () => {
      // Transcript and fallback observers must await the same delivery settlements.
      await Promise.all(state.pendingTranscriptOutcomes);
      return state.accumulatedDeliveredFinalText || getBlockTranscriptText(true);
    },
    settleVisibleText: settleDirectVisibleText,
    hasDeliveredFinalReply: () => state.deliveredFinalReply,
    hasPendingAnswerDelivery: () => state.pendingAnswerDelivery,
    hasPendingFinalTtsMedia: () => state.pendingFinalTtsMedia,
    hasDeliveredAnswerFinalToUser: () => state.deliveredAnswerFinalToUser,
    hasDeliveredFinalTtsMedia: () => state.deliveredFinalTtsMedia,
    hasDeliveredVisibleText: () => state.deliveredVisibleText,
    hasFailedVisibleTextDelivery: () => state.failedVisibleTextDelivery,
    getDeliverySuppressionReason: () => state.suppressionReason,
    getRoutedCounts: () => ({ ...state.routedCounts }),
    applyRoutedCounts: (counts: Record<ReplyDispatchKind, number>) => {
      counts.tool += state.routedCounts.tool;
      counts.block += state.routedCounts.block;
      counts.final += state.routedCounts.final;
    },
  };
}
