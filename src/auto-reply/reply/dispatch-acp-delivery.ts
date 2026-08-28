// Delivers ACP turn results through reply payload routing.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
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
import { resolveStatusTtsSnapshot } from "../../tts/status-config.js";
import { resolveConfiguredTtsMode, shouldCleanTtsDirectiveText } from "../../tts/tts-config.js";
import {
  copyReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  isReplyPayloadTtsSupplement,
} from "../reply-payload.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { prepareAcpDeliveryPayload } from "./dispatch-acp-payload.js";
import type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";
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
const dispatchAcpTtsRuntimeLoader = createLazyImportLoader(
  () => import("../../tts/tts.runtime.js"),
);
const channelPluginRuntimeLoader = createLazyImportLoader(
  () => import("../../channels/plugins/index.js"),
);
const messageActionRuntimeLoader = createLazyImportLoader(
  () => import("../../infra/outbound/message-action-runner.js"),
);

function loadRouteReplyRuntime() {
  return routeReplyRuntimeLoader.load();
}

function loadDispatchAcpTtsRuntime() {
  return dispatchAcpTtsRuntimeLoader.load();
}

function loadChannelPluginRuntime() {
  return channelPluginRuntimeLoader.load();
}

function loadMessageActionRuntime() {
  return messageActionRuntimeLoader.load();
}

type AcpDispatchDeliveryMeta = {
  toolCallId?: string;
  allowEdit?: boolean;
  skipTts?: boolean;
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
  routed: boolean;
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
  const { getChannelPlugin } = await loadChannelPluginRuntime();
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

async function maybeApplyAcpTts(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  agentId?: string;
  channel?: string;
  accountId?: string;
  kind: ReplyDispatchKind;
  inboundAudio: boolean;
  ttsAuto?: TtsAutoMode;
  skipTts?: boolean;
}): Promise<ReplyPayload> {
  if (params.skipTts) {
    return params.payload;
  }
  if (isReplyPayloadStatusNotice(params.payload)) {
    return params.payload;
  }
  const ttsStatus = resolveStatusTtsSnapshot({
    cfg: params.cfg,
    sessionAuto: params.ttsAuto,
    agentId: params.agentId,
    channelId: params.channel,
    accountId: params.accountId,
  });
  if (!ttsStatus) {
    return params.payload;
  }
  if (ttsStatus.autoMode === "inbound" && !params.inboundAudio) {
    return params.payload;
  }
  if (
    params.kind !== "final" &&
    resolveConfiguredTtsMode(params.cfg, {
      agentId: params.agentId,
      channelId: params.channel,
      accountId: params.accountId,
    }) === "final"
  ) {
    return params.payload;
  }
  const { maybeApplyTtsToPayload } = await loadDispatchAcpTtsRuntime();
  const applied = await maybeApplyTtsToPayload({
    payload: params.payload,
    cfg: params.cfg,
    channel: params.channel,
    kind: params.kind,
    inboundAudio: params.inboundAudio,
    ttsAuto: params.ttsAuto,
    agentId: params.agentId,
    accountId: params.accountId,
  });
  return copyReplyPayloadMetadata(params.payload, applied);
}

type AcpDispatchDeliveryState = {
  startedReplyLifecycle: boolean;
  accumulatedBlockText: string;
  accumulatedDeliveredBlockText: string;
  accumulatedVisibleBlockText: string;
  accumulatedBlockTtsText: string;
  accumulatedFinalText: string;
  accumulatedDeliveredFinalText: string;
  pendingTranscriptOutcomes: Promise<void>[];
  cleanBlockTtsDirectiveText?: ReturnType<typeof createTtsDirectiveTextStreamCleaner>;
  blockCount: number;
  deliveredFinalReply: boolean;
  deliveredAnswerFinalToUser: boolean;
  deliveredFinalTtsMedia: boolean;
  deliveredVisibleText: boolean;
  failedVisibleTextDelivery: boolean;
  queuedDirectVisibleTextDeliveries: number;
  settledDirectVisibleText: boolean;
  routedCounts: Record<ReplyDispatchKind, number>;
  suppressionReason?: NormalizeReplySkipReason;
  toolMessageByCallId: Map<string, ToolMessageHandle>;
};

export type AcpDispatchDeliveryCoordinator = {
  startReplyLifecycle: () => Promise<void>;
  deliver: (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    meta?: AcpDispatchDeliveryMeta,
  ) => Promise<boolean>;
  getBlockCount: () => number;
  getAccumulatedBlockText: () => string;
  getAccumulatedVisibleBlockText: () => string;
  getAccumulatedBlockTtsText: () => string;
  getAccumulatedFinalText: () => string;
  getAccumulatedTranscriptText: () => string;
  resolveAccumulatedDeliveredTranscriptText: () => Promise<string>;
  settleVisibleText: () => Promise<void>;
  hasDeliveredFinalReply: () => boolean;
  hasDeliveredAnswerFinalToUser: () => boolean;
  hasDeliveredFinalTtsMedia: () => boolean;
  hasDeliveredVisibleText: () => boolean;
  hasFailedVisibleTextDelivery: () => boolean;
  getDeliverySuppressionReason: () => NormalizeReplySkipReason | undefined;
  getRoutedCounts: () => Record<ReplyDispatchKind, number>;
  applyRoutedCounts: (counts: Record<ReplyDispatchKind, number>) => void;
};

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
}): AcpDispatchDeliveryCoordinator {
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
    accumulatedBlockText: "",
    accumulatedDeliveredBlockText: "",
    accumulatedVisibleBlockText: "",
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
    blockCount: 0,
    deliveredFinalReply: false,
    deliveredAnswerFinalToUser: false,
    deliveredFinalTtsMedia: false,
    deliveredVisibleText: false,
    failedVisibleTextDelivery: false,
    queuedDirectVisibleTextDeliveries: 0,
    settledDirectVisibleText: false,
    routedCounts: {
      tool: 0,
      block: 0,
      final: 0,
    },
    suppressionReason: undefined,
    toolMessageByCallId: new Map(),
  };
  let hasPendingDirectBlockReplyDelivery = false;

  const appendDeliveredTranscriptText = (
    kind: ReplyDispatchKind,
    blockText: string | undefined,
    finalText: string | undefined,
  ) => {
    // ACP history keeps canonical runtime text, while delivery hooks may render
    // transport-specific text. Only the delivery outcome gates this snapshot.
    if (kind === "block" && blockText) {
      state.accumulatedDeliveredBlockText = state.accumulatedDeliveredBlockText
        ? `${state.accumulatedDeliveredBlockText}\n${blockText}`
        : blockText;
    }
    if (kind === "final" && finalText) {
      state.accumulatedDeliveredFinalText = state.accumulatedDeliveredFinalText
        ? `${state.accumulatedDeliveredFinalText}\n${finalText}`
        : finalText;
    }
  };
  const waitForPendingDirectBlockReplyDelivery = async () => {
    if (!hasPendingDirectBlockReplyDelivery) {
      return;
    }
    // ACP direct block replies should not block the common visible-reply path.
    // Defer the idle wait until a later tool delivery would otherwise overtake
    // that block reply in user-visible ordering.
    hasPendingDirectBlockReplyDelivery = false;
    await waitForReplyDispatcherIdle(params.dispatcher, params.abortSignal);
  };
  const settleDirectVisibleText = async () => {
    if (state.settledDirectVisibleText || state.queuedDirectVisibleTextDeliveries === 0) {
      return;
    }
    state.settledDirectVisibleText = true;
    hasPendingDirectBlockReplyDelivery = false;
    const receipt = await params.dispatcher.waitForIdle();
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
      logVerbose(
        `dispatch-acp: reply lifecycle start failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const tryEditToolMessage = async (
    payload: ReplyPayload,
    toolCallId: string,
  ): Promise<boolean> => {
    if (!params.shouldRouteToOriginating || !params.originatingChannel || !params.originatingTo) {
      return false;
    }
    const handle = state.toolMessageByCallId.get(toolCallId);
    if (!handle?.messageId) {
      return false;
    }
    const message = normalizeOptionalString(payload.text);
    if (!message) {
      return false;
    }

    try {
      const { runMessageAction } = await loadMessageActionRuntime();
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
    let visiblePayload = payload;
    if (!params.suppressUserDelivery) {
      const routed = params.shouldRouteToOriginating && routedChannel !== undefined;
      const messaging = routed
        ? (await loadChannelPluginRuntime()).getChannelPlugin(routedChannel)?.messaging
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
        }
        return false;
      }
      visiblePayload = prepared.payload;
    }
    const isStatusNotice = isReplyPayloadStatusNotice(visiblePayload);
    const rawBlockPayloadText =
      kind === "block" ? normalizeOptionalString(visiblePayload.text) : undefined;
    const rawBlockText = isStatusNotice ? undefined : rawBlockPayloadText;
    if (rawBlockPayloadText) {
      const joinsBufferedTtsDirective =
        state.cleanBlockTtsDirectiveText?.hasBufferedDirectiveText() === true;
      if (rawBlockText) {
        if (state.accumulatedBlockText.length > 0) {
          state.accumulatedBlockText += "\n";
        }
        state.accumulatedBlockText += rawBlockText;
        if (state.accumulatedBlockTtsText.length > 0 && !joinsBufferedTtsDirective) {
          state.accumulatedBlockTtsText += "\n";
        }
        state.accumulatedBlockTtsText += rawBlockText;
        state.blockCount += 1;
      }

      if (state.cleanBlockTtsDirectiveText && rawBlockText) {
        const text = state.cleanBlockTtsDirectiveText.push(rawBlockPayloadText);
        visiblePayload = copyReplyPayloadMetadata(visiblePayload, {
          ...visiblePayload,
          text: text.trim() ? text : undefined,
        });
      }
      if (visiblePayload.text) {
        if (state.accumulatedVisibleBlockText.length > 0) {
          state.accumulatedVisibleBlockText += "\n";
        }
        state.accumulatedVisibleBlockText += visiblePayload.text;
      }
    }
    const rawFinalText =
      kind === "final" && !isStatusNotice
        ? normalizeOptionalString(visiblePayload.text)
        : undefined;
    if (rawFinalText) {
      if (state.accumulatedFinalText.length > 0) {
        state.accumulatedFinalText += "\n";
      }
      state.accumulatedFinalText += rawFinalText;
    }

    if (hasOutboundReplyContent(visiblePayload, { trimText: true })) {
      await startReplyLifecycleOnce();
    } else {
      return false;
    }

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
    const hasFinalTtsMedia =
      kind === "final" &&
      resolveSendableOutboundReplyParts(ttsPayload).hasMedia &&
      isReplyPayloadTtsSupplement(ttsPayload);
    const isAnswerBearingFinal = kind === "final" && isCaptionedFinalTextPayload(visiblePayload);

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
        routed: true,
      });
      const { routeReply } = await loadRouteReplyRuntime();
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
      if (!result.delivered && hasFinalTtsMedia && ttsPayload.text?.trim()) {
        if (!result.suppressed) {
          logVerbose(
            `dispatch-acp: route-reply (acp/${kind}) failed: ${result.error ?? "unknown error"}`,
          );
        }
        return await deliver("final", { text: ttsPayload.text }, { skipTts: true });
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
      appendDeliveredTranscriptText(kind, rawBlockText, rawFinalText);
      if (kind === "final") {
        state.deliveredFinalReply = true;
        if (isAnswerBearingFinal) {
          state.deliveredAnswerFinalToUser = true;
          state.deliveredFinalTtsMedia = hasFinalTtsMedia;
        }
      }
      if (tracksVisibleText) {
        state.deliveredVisibleText = true;
      }
      state.routedCounts[kind] += 1;
      return true;
    }

    if (kind === "tool") {
      await waitForPendingDirectBlockReplyDelivery();
    }

    const tracksVisibleText = await shouldTreatDeliveredTextAsVisible({
      channel: directChannel,
      kind,
      text: ttsPayload.text,
      routed: false,
    });
    const transcriptOutcome =
      rawBlockText || rawFinalText || hasFinalTtsMedia
        ? captureReplyDispatchDeliveryOutcome(ttsPayload)
        : undefined;
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
    if (delivered && transcriptOutcome) {
      if (transcriptOutcome.isTracked()) {
        state.pendingTranscriptOutcomes.push(
          transcriptOutcome.promise.then((outcome) => {
            if (outcome === "delivered") {
              appendDeliveredTranscriptText(kind, rawBlockText, rawFinalText);
            }
          }),
        );
      }
    }
    if (kind === "final" && delivered) {
      state.deliveredFinalReply = true;
      if (isAnswerBearingFinal) {
        state.deliveredAnswerFinalToUser = true;
        state.deliveredFinalTtsMedia = hasFinalTtsMedia;
      }
    }
    if (delivered && tracksVisibleText) {
      state.queuedDirectVisibleTextDeliveries += 1;
      state.settledDirectVisibleText = false;
    } else if (!delivered && tracksVisibleText) {
      state.failedVisibleTextDelivery = true;
    }
    if (kind === "block" && delivered) {
      hasPendingDirectBlockReplyDelivery = true;
    }
    return delivered;
  };

  return {
    startReplyLifecycle: startReplyLifecycleOnce,
    deliver,
    getBlockCount: () => state.blockCount,
    getAccumulatedBlockText: () => state.accumulatedBlockText,
    getAccumulatedVisibleBlockText: () => state.accumulatedVisibleBlockText,
    getAccumulatedBlockTtsText: () => state.accumulatedBlockTtsText,
    getAccumulatedFinalText: () => state.accumulatedFinalText,
    getAccumulatedTranscriptText: () => state.accumulatedFinalText || state.accumulatedBlockText,
    resolveAccumulatedDeliveredTranscriptText: async () => {
      await Promise.all(state.pendingTranscriptOutcomes.splice(0));
      return state.accumulatedDeliveredFinalText || state.accumulatedDeliveredBlockText;
    },
    settleVisibleText: settleDirectVisibleText,
    hasDeliveredFinalReply: () => state.deliveredFinalReply,
    hasDeliveredAnswerFinalToUser: () => state.deliveredAnswerFinalToUser,
    hasDeliveredFinalTtsMedia: () => state.deliveredFinalTtsMedia,
    hasDeliveredVisibleText: () => state.deliveredVisibleText,
    hasFailedVisibleTextDelivery: () => state.failedVisibleTextDelivery,
    getDeliverySuppressionReason: () => state.suppressionReason,
    getRoutedCounts: () => ({ ...state.routedCounts }),
    applyRoutedCounts: (counts) => {
      counts.tool += state.routedCounts.tool;
      counts.block += state.routedCounts.block;
      counts.final += state.routedCounts.final;
    },
  };
}
