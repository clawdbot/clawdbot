import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { createTtsDirectiveTextStreamCleaner } from "../../tts/directives.js";
import { resolveStatusTtsSnapshot } from "../../tts/status-config.js";
import { resolveConfiguredTtsMode, shouldCleanTtsDirectiveText } from "../../tts/tts-config.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

let routeReplyRuntimePromise: Promise<typeof import("./route-reply.runtime.js")> | null = null;
let dispatchAcpTtsRuntimePromise: Promise<typeof import("./dispatch-acp-tts.runtime.js")> | null =
  null;
let channelPluginRuntimePromise: Promise<typeof import("../../channels/plugins/index.js")> | null =
  null;
let messageActionRuntimePromise: Promise<
  typeof import("../../infra/outbound/message-action-runner.js")
> | null = null;

function loadRouteReplyRuntime() {
  routeReplyRuntimePromise ??= import("./route-reply.runtime.js");
  return routeReplyRuntimePromise;
}

function loadDispatchAcpTtsRuntime() {
  dispatchAcpTtsRuntimePromise ??= import("./dispatch-acp-tts.runtime.js");
  return dispatchAcpTtsRuntimePromise;
}

function loadChannelPluginRuntime() {
  channelPluginRuntimePromise ??= import("../../channels/plugins/index.js");
  return channelPluginRuntimePromise;
}

function loadMessageActionRuntime() {
  messageActionRuntimePromise ??= import("../../infra/outbound/message-action-runner.js");
  return messageActionRuntimePromise;
}

export type AcpDispatchDeliveryMeta = {
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
  return await maybeApplyTtsToPayload({
    payload: params.payload,
    cfg: params.cfg,
    channel: params.channel,
    kind: params.kind,
    inboundAudio: params.inboundAudio,
    ttsAuto: params.ttsAuto,
    agentId: params.agentId,
    accountId: params.accountId,
  });
}

type AcpDispatchDeliveryState = {
  startedReplyLifecycle: boolean;
  accumulatedBlockText: string;
  accumulatedVisibleBlockText: string;
  accumulatedBlockTtsText: string;
  cleanBlockTtsDirectiveText?: ReturnType<typeof createTtsDirectiveTextStreamCleaner>;
  blockCount: number;
  deliveredFinalReply: boolean;
  deliveredVisibleText: boolean;
  failedVisibleTextDelivery: boolean;
  queuedDirectVisibleTextDeliveries: number;
  settledDirectVisibleText: boolean;
  routedCounts: Record<ReplyDispatchKind, number>;
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
  settleVisibleText: () => Promise<void>;
  hasDeliveredFinalReply: () => boolean;
  hasDeliveredVisibleText: () => boolean;
  hasFailedVisibleTextDelivery: () => boolean;
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
  shouldRouteToOriginating: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  onReplyStart?: () => Promise<void> | void;
}): AcpDispatchDeliveryCoordinator {
  const directChannel = normalizeOptionalLowercaseString(params.ctx.Provider ?? params.ctx.Surface);
  const routedChannel = normalizeOptionalLowercaseString(params.originatingChannel);
  const deliverySessionKey = normalizeOptionalString(params.sessionKey) ?? params.ctx.SessionKey;
  const explicitAccountId = normalizeOptionalString(params.ctx.AccountId);
  const resolvedAccountId =
    explicitAccountId ??
    normalizeOptionalString(
      (
        params.cfg.channels as Record<string, { defaultAccount?: unknown } | undefined> | undefined
      )?.[routedChannel ?? directChannel ?? ""]?.defaultAccount,
    );
  const state: AcpDispatchDeliveryState = {
    startedReplyLifecycle: false,
    accumulatedBlockText: "",
    accumulatedVisibleBlockText: "",
    accumulatedBlockTtsText: "",
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
    deliveredVisibleText: false,
    failedVisibleTextDelivery: false,
    queuedDirectVisibleTextDeliveries: 0,
    settledDirectVisibleText: false,
    routedCounts: {
      tool: 0,
      block: 0,
      final: 0,
    },
    toolMessageByCallId: new Map(),
  };
  const settleDirectVisibleText = async () => {
    if (state.settledDirectVisibleText || state.queuedDirectVisibleTextDeliveries === 0) {
      return;
    }
    state.settledDirectVisibleText = true;
    await params.dispatcher.waitForIdle();
    const failedCounts = params.dispatcher.getFailedCounts();
    const failedVisibleCount = failedCounts.block + failedCounts.final;
    if (failedVisibleCount > 0) {
      state.failedVisibleTextDelivery = true;
    }
    if (state.queuedDirectVisibleTextDeliveries > failedVisibleCount) {
      state.deliveredVisibleText = true;
    }
  };

  const startReplyLifecycleOnce = async () => {
    if (state.startedReplyLifecycle) {
      return;
    }
    state.startedReplyLifecycle = true;
    // When delivery is suppressed (e.g. sendPolicy: "deny"), do not fire the
    // onReplyStart callback — channels wire it to typing indicators / lifecycle
    // notifications that should not leak outbound events while the session is
    // under a deny policy. See #53328.
    if (params.suppressUserDelivery) {
      return;
    }
    void Promise.resolve(params.onReplyStart?.()).catch((error) => {
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
          accountId: handle.accountId,
          to: handle.to,
          threadId: handle.threadId,
          messageId: handle.messageId,
          message,
        },
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
    const rawBlockText = kind === "block" ? normalizeOptionalString(payload.text) : undefined;
    if (rawBlockText) {
      const joinsBufferedTtsDirective =
        state.cleanBlockTtsDirectiveText?.hasBufferedDirectiveText() === true;
      if (state.accumulatedBlockText.length > 0) {
        state.accumulatedBlockText += "\n";
      }
      state.accumulatedBlockText += rawBlockText;
      if (state.accumulatedBlockTtsText.length > 0 && !joinsBufferedTtsDirective) {
        state.accumulatedBlockTtsText += "\n";
      }
      state.accumulatedBlockTtsText += rawBlockText;
      state.blockCount += 1;

      if (state.cleanBlockTtsDirectiveText && !payload.isCompactionNotice) {
        const text = state.cleanBlockTtsDirectiveText.push(rawBlockText);
        visiblePayload = { ...payload, text: text.trim() ? text : undefined };
      }
      if (visiblePayload.text) {
        if (state.accumulatedVisibleBlockText.length > 0) {
          state.accumulatedVisibleBlockText += "\n";
        }
        state.accumulatedVisibleBlockText += visiblePayload.text;
      }
    }

    if (hasOutboundReplyContent(visiblePayload, { trimText: true })) {
      await startReplyLifecycleOnce();
    } else {
      return false;
    }

    if (params.suppressUserDelivery) {
      return false;
    }

    const ttsPayload = await maybeApplyAcpTts({
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
        threadId: params.ctx.MessageThreadId,
        cfg: params.cfg,
        mirror: false,
      });
      if (!result.ok) {
        if (tracksVisibleText) {
          state.failedVisibleTextDelivery = true;
        }
        logVerbose(
          `dispatch-acp: route-reply (acp/${kind}) failed: ${result.error ?? "unknown error"}`,
        );
        return false;
      }
      if (kind === "tool" && meta?.toolCallId && result.messageId) {
        state.toolMessageByCallId.set(meta.toolCallId, {
          channel: params.originatingChannel,
          accountId: resolvedAccountId,
          to: params.originatingTo,
          ...(params.ctx.MessageThreadId != null ? { threadId: params.ctx.MessageThreadId } : {}),
          messageId: result.messageId,
        });
      }
      if (kind === "final") {
        state.deliveredFinalReply = true;
      }
      if (tracksVisibleText) {
        state.deliveredVisibleText = true;
      }
      state.routedCounts[kind] += 1;
      return true;
    }

    const tracksVisibleText = await shouldTreatDeliveredTextAsVisible({
      channel: directChannel,
      kind,
      text: ttsPayload.text,
      routed: false,
    });
    const delivered =
      kind === "tool"
        ? params.dispatcher.sendToolResult(ttsPayload)
        : kind === "block"
          ? params.dispatcher.sendBlockReply(ttsPayload)
          : params.dispatcher.sendFinalReply(ttsPayload);
    if (kind === "final" && delivered) {
      state.deliveredFinalReply = true;
    }
    if (delivered && tracksVisibleText) {
      state.queuedDirectVisibleTextDeliveries += 1;
      state.settledDirectVisibleText = false;
    } else if (!delivered && tracksVisibleText) {
      state.failedVisibleTextDelivery = true;
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
    settleVisibleText: settleDirectVisibleText,
    hasDeliveredFinalReply: () => state.deliveredFinalReply,
    hasDeliveredVisibleText: () => state.deliveredVisibleText,
    hasFailedVisibleTextDelivery: () => state.failedVisibleTextDelivery,
    getRoutedCounts: () => ({ ...state.routedCounts }),
    applyRoutedCounts: (counts) => {
      counts.tool += state.routedCounts.tool;
      counts.block += state.routedCounts.block;
      counts.final += state.routedCounts.final;
    },
  };
}
