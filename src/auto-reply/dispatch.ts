/** Auto-reply dispatch orchestration, hook composition, and foreground delivery fencing. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import {
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../infra/diagnostics-timeline.js";
import {
  buildInboundReplyPayloadSendingBeforeDeliver,
  buildLegacyInboundMessageSendingBeforeDeliver,
  buildProjectedInboundMessageSendingBeforeDeliver,
  type ReplyPayloadSuppressedObserver,
} from "../infra/outbound/deliver-hooks.js";
import { logMessageReceived } from "../logging/diagnostic.js";
import { createKeyedFifoLeaseRegistry, type KeyedFifoLease } from "../shared/keyed-fifo-lease.js";
import type { SilentReplyConversationType } from "../shared/silent-reply-policy.js";
import {
  resolveCommandTurnContext,
  resolveCommandTurnTargetSessionKey,
} from "./command-turn-context.js";
import { withReplyDispatcher } from "./dispatch-dispatcher.js";
import type { CommandSessionMetadataChange } from "./reply/command-session-metadata.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import type {
  DispatchFromConfigResult,
  DispatchReplyFromConfig,
} from "./reply/dispatch-from-config.types.js";
import type {
  InternalGetReplyFromConfig,
  InternalGetReplyOptions,
} from "./reply/get-reply.types.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import {
  composeReplyDispatchBeforeDeliver,
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  markReplyDispatchBeforeDeliverDeadlineOwned,
  type ReplyDispatchBeforeDeliver,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
} from "./reply/reply-dispatcher.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";

type InternalDispatchReplyOptions = Omit<InternalGetReplyOptions, "onBlockReply">;

type ReplyPayloadRunState = {
  runId?: string;
};

const replyPayloadSendingDispatchers = new WeakSet<ReplyDispatcher>();
const foregroundReplyLeases = createKeyedFifoLeaseRegistry(
  Symbol.for("openclaw.foregroundReplyFences"),
);

function applyRuntimeToolsAllow(
  replyOptions: InternalDispatchReplyOptions | undefined,
  toolsAllow: string[] | undefined,
): InternalDispatchReplyOptions | undefined {
  if (toolsAllow === undefined) {
    return replyOptions;
  }
  return {
    ...replyOptions,
    toolsAllow,
  };
}

function resolveForegroundReplyOrderKey(finalized: FinalizedMsgContext): string | undefined {
  const sessionKey = normalizeOptionalString(finalized.SessionKey);
  const channel =
    normalizeOptionalString(finalized.OriginatingChannel) ??
    normalizeOptionalString(finalized.Surface) ??
    normalizeOptionalString(finalized.Provider);
  const target =
    normalizeOptionalString(finalized.OriginatingTo) ??
    normalizeOptionalString(finalized.NativeChannelId) ??
    normalizeOptionalString(finalized.From) ??
    normalizeOptionalString(finalized.To);

  if (!sessionKey || !channel || !target) {
    return undefined;
  }

  // JSON keeps the composite key unambiguous across account/session/channel ids.
  return JSON.stringify([
    "foreground",
    channel,
    normalizeOptionalString(finalized.AccountId) ?? "default",
    sessionKey,
    normalizeChatType(finalized.ChatType) ?? "unknown",
    target,
  ]);
}

function reserveForegroundReplyLease(finalized: FinalizedMsgContext): KeyedFifoLease | undefined {
  const key = resolveForegroundReplyOrderKey(finalized);
  return key ? foregroundReplyLeases.reserve([key]) : undefined;
}

async function runOrderedForegroundReplySettledDeliveries(
  lease: KeyedFifoLease | undefined,
  onSettled: (() => unknown) | undefined,
  onFreshSettledDelivery: (() => unknown) | undefined,
): Promise<void> {
  if (!onSettled && !onFreshSettledDelivery) {
    return;
  }
  await lease?.wait();
  await onSettled?.();
  await onFreshSettledDelivery?.();
}

function resolveDispatcherSilentReplyContext(
  ctx: MsgContext | FinalizedMsgContext,
  cfg: OpenClawConfig,
) {
  const finalized = finalizeInboundContext(ctx);
  const commandTargetSessionKey = resolveCommandTurnTargetSessionKey(finalized);
  const policySessionKey = commandTargetSessionKey ?? finalized.SessionKey;
  const chatType = normalizeChatType(finalized.ChatType);
  const conversationType: SilentReplyConversationType | undefined =
    commandTargetSessionKey && commandTargetSessionKey !== finalized.SessionKey
      ? undefined
      : chatType === "direct"
        ? "direct"
        : chatType === "group" || chatType === "channel"
          ? "group"
          : undefined;
  // Cross-session native command dispatch bypasses direct/group inference for silent policy.
  return {
    cfg,
    sessionKey: policySessionKey,
    surface: finalized.Surface ?? finalized.Provider,
    conversationType,
  };
}

function bindReplyPayloadRunState(
  replyOptions: InternalDispatchReplyOptions | undefined,
  runState: ReplyPayloadRunState,
): InternalDispatchReplyOptions {
  const onAgentRunStart = replyOptions?.onAgentRunStart;
  return {
    ...replyOptions,
    onAgentRunStart: (...args) => {
      runState.runId = args[0];
      return onAgentRunStart?.(...args);
    },
  };
}

function installReplyPayloadSendingBeforeDeliver(
  dispatcher: ReplyDispatcher,
  ctx: MsgContext | FinalizedMsgContext,
  runState: ReplyPayloadRunState,
): void {
  if (replyPayloadSendingDispatchers.has(dispatcher)) {
    return;
  }
  const beforeDeliver = buildInboundReplyPayloadSendingBeforeDeliver(ctx, runState);
  if (!beforeDeliver || !dispatcher.appendBeforeDeliver) {
    return;
  }
  dispatcher.appendBeforeDeliver(beforeDeliver);
  replyPayloadSendingDispatchers.add(dispatcher);
}

function markReplyPayloadSendingBeforeDeliverInstalled(
  dispatcher: ReplyDispatcher,
  beforeDeliver: ReplyDispatchBeforeDeliver | undefined,
): void {
  if (beforeDeliver) {
    replyPayloadSendingDispatchers.add(dispatcher);
  }
}

function buildDispatchTimelineAttributes(ctx: MsgContext | FinalizedMsgContext) {
  const commandTurn = resolveCommandTurnContext(ctx);
  return {
    surface:
      typeof ctx.Surface === "string"
        ? ctx.Surface
        : typeof ctx.Provider === "string"
          ? ctx.Provider
          : "unknown",
    hasSessionKey:
      typeof ctx.SessionKey === "string" || typeof ctx.CommandTargetSessionKey === "string",
    commandSource: commandTurn.source,
  };
}

type DispatchInboundResult = DispatchFromConfigResult;
export { settleReplyDispatcher } from "./dispatch-dispatcher.js";

/** Dispatches one finalized inbound message through reply resolution and queued delivery. */
export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  toolsAllow?: string[];
  replyOptions?: InternalDispatchReplyOptions;
  replyResolver?: InternalGetReplyFromConfig;
  dispatchReplyFromConfig?: DispatchReplyFromConfig;
  onSessionMetadataChanges?: (changes: CommandSessionMetadataChange[]) => void;
  replyPayloadRunState?: ReplyPayloadRunState;
  /** Observe-only turns run the agent without entering outbound hook stages. */
  outboundHooks?: "enabled" | "disabled";
  onSettled?: () => void | Promise<void>;
}): Promise<DispatchInboundResult> {
  const replyOptions = applyRuntimeToolsAllow(params.replyOptions, params.toolsAllow);
  const replyPayloadRunState = params.replyPayloadRunState ?? {
    runId: replyOptions?.runId,
  };
  const replyOptionsWithRunState = bindReplyPayloadRunState(replyOptions, replyPayloadRunState);
  const finalized = measureDiagnosticsTimelineSpanSync(
    "auto_reply.finalize_context",
    () => finalizeInboundContext(params.ctx),
    {
      phase: "agent-turn",
      config: params.cfg,
      attributes: buildDispatchTimelineAttributes(params.ctx),
    },
  );
  if (isDiagnosticsEnabled(params.cfg)) {
    logMessageReceived({
      sessionKey: finalized.SessionKey,
      channel: finalized.Surface ?? finalized.Provider,
      chatId: finalized.To ?? finalized.From,
      messageId: finalized.MessageSid ?? finalized.MessageSidFirst ?? finalized.MessageSidLast,
      source: "dispatchInboundMessage",
    });
  }
  if (params.outboundHooks !== "disabled") {
    installReplyPayloadSendingBeforeDeliver(params.dispatcher, finalized, replyPayloadRunState);
  }
  let settledReceipt: DispatchFromConfigResult["settledReceipt"];
  const result = await withReplyDispatcher({
    dispatcher: params.dispatcher,
    onSettled: params.onSettled,
    run: () =>
      measureDiagnosticsTimelineSpan(
        "auto_reply.dispatch_reply_from_config",
        () =>
          (params.dispatchReplyFromConfig ?? dispatchReplyFromConfig)({
            ctx: finalized,
            cfg: params.cfg,
            dispatcher: params.dispatcher,
            replyOptions: replyOptionsWithRunState,
            replyResolver: params.replyResolver,
            onSessionMetadataChanges: params.onSessionMetadataChanges,
            usePublishedModelRuntime: true,
          }),
        {
          phase: "agent-turn",
          config: params.cfg,
          attributes: buildDispatchTimelineAttributes(finalized),
        },
      ),
    onSettledReceipt: (receipt) => {
      settledReceipt = receipt;
    },
  });
  return settledReceipt ? { ...result, settledReceipt } : result;
}

type BufferedInboundDispatcherParams = {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  toolsAllow?: string[];
  replyOptions?: InternalDispatchReplyOptions;
  replyResolver?: InternalGetReplyFromConfig;
  dispatchReplyFromConfig?: DispatchReplyFromConfig;
  onSessionMetadataChanges?: (changes: CommandSessionMetadataChange[]) => void;
};

async function dispatchInboundMessageWithBufferedDispatcherCore(
  params: BufferedInboundDispatcherParams,
  ownership: {
    messageSending: "dispatcher" | "channel-delivery";
    outboundHooks?: "enabled" | "disabled";
    onReplyPayloadSuppressed?: ReplyPayloadSuppressedObserver;
  },
): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(params.ctx);
  const foregroundReplyLease = reserveForegroundReplyLease(finalized);
  const silentReplyContext = resolveDispatcherSilentReplyContext(finalized, params.cfg);
  const replyPayloadRunState = {
    runId: params.replyOptions?.runId,
  };
  let settledDeliveries = Promise.resolve();
  const settleDeliveries = () =>
    (settledDeliveries = settledDeliveries.then(() =>
      runOrderedForegroundReplySettledDeliveries(
        foregroundReplyLease,
        params.dispatcherOptions.onSettled,
        params.dispatcherOptions.onFreshSettledDelivery,
      ),
    ));
  const replyPayloadBeforeDeliver =
    ownership.outboundHooks === "disabled"
      ? undefined
      : buildInboundReplyPayloadSendingBeforeDeliver(
          finalized,
          replyPayloadRunState,
          ownership.onReplyPayloadSuppressed,
        );
  const globalBeforeDeliver =
    ownership.messageSending === "dispatcher"
      ? composeReplyDispatchBeforeDeliver(
          replyPayloadBeforeDeliver,
          buildLegacyInboundMessageSendingBeforeDeliver(finalized),
        )
      : replyPayloadBeforeDeliver;
  const configuredBeforeDeliver = params.dispatcherOptions.beforeDeliver
    ? composeReplyDispatchBeforeDeliver(
        {
          hook: params.dispatcherOptions.beforeDeliver,
          options: params.dispatcherOptions.beforeDeliverOptions,
        },
        replyPayloadBeforeDeliver,
      )
    : globalBeforeDeliver;
  const beforeDeliver: ReplyDispatchBeforeDeliver | undefined =
    foregroundReplyLease || configuredBeforeDeliver
      ? markReplyDispatchBeforeDeliverDeadlineOwned(async (payload, info) => {
          await foregroundReplyLease?.wait();
          return configuredBeforeDeliver ? await configuredBeforeDeliver(payload, info) : payload;
        })
      : undefined;
  const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } =
    createReplyDispatcherWithTyping({
      ...params.dispatcherOptions,
      beforeDeliver,
      onSettled: settleDeliveries,
      onFreshSettledDelivery: undefined,
      silentReplyContext: params.dispatcherOptions.silentReplyContext ?? silentReplyContext,
    });
  const onTypingController = params.replyOptions?.onTypingController
    ? (typing: Parameters<NonNullable<typeof params.replyOptions.onTypingController>>[0]) => {
        replyOptions.onTypingController?.(typing);
        params.replyOptions?.onTypingController?.(typing);
      }
    : replyOptions.onTypingController;
  markReplyPayloadSendingBeforeDeliverInstalled(dispatcher, replyPayloadBeforeDeliver);
  try {
    return await dispatchInboundMessage({
      ctx: finalized,
      cfg: params.cfg,
      dispatcher,
      toolsAllow: params.toolsAllow,
      replyResolver: params.replyResolver,
      dispatchReplyFromConfig: params.dispatchReplyFromConfig,
      replyOptions: {
        ...params.replyOptions,
        ...replyOptions,
        onTypingController,
      },
      replyPayloadRunState,
      outboundHooks: ownership.outboundHooks,
      onSessionMetadataChanges: params.onSessionMetadataChanges,
    });
  } finally {
    try {
      await settledDeliveries;
    } finally {
      foregroundReplyLease?.release();
      markRunComplete();
      markDispatchIdle();
    }
  }
}

export async function dispatchInboundMessageWithBufferedDispatcher(
  params: BufferedInboundDispatcherParams,
): Promise<DispatchInboundResult> {
  return await dispatchInboundMessageWithBufferedDispatcherCore(params, {
    messageSending: "dispatcher",
  });
}

export async function dispatchInboundMessageWithRoutedChannelDispatcher(
  params: BufferedInboundDispatcherParams & {
    onReplyPayloadSuppressed?: ReplyPayloadSuppressedObserver;
    suppressOutboundHooks?: true;
  },
): Promise<DispatchInboundResult> {
  const { onReplyPayloadSuppressed, suppressOutboundHooks, ...dispatcherParams } = params;
  return await dispatchInboundMessageWithBufferedDispatcherCore(dispatcherParams, {
    messageSending: "channel-delivery",
    ...(suppressOutboundHooks
      ? { outboundHooks: "disabled" as const }
      : { onReplyPayloadSuppressed }),
  });
}

type PlainInboundDispatcherParams = {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  toolsAllow?: string[];
  replyOptions?: InternalDispatchReplyOptions;
  replyResolver?: InternalGetReplyFromConfig;
  onSessionMetadataChanges?: (changes: CommandSessionMetadataChange[]) => void;
};

async function dispatchInboundMessageWithPlainDispatcherCore(
  params: PlainInboundDispatcherParams,
  messageSending: "legacy" | "projected",
): Promise<DispatchInboundResult> {
  const silentReplyContext = resolveDispatcherSilentReplyContext(params.ctx, params.cfg);
  const replyPayloadRunState = {
    runId: params.replyOptions?.runId,
  };
  const replyPayloadBeforeDeliver = buildInboundReplyPayloadSendingBeforeDeliver(
    params.ctx,
    replyPayloadRunState,
  );
  const messageSendingBeforeDeliver =
    messageSending === "projected"
      ? buildProjectedInboundMessageSendingBeforeDeliver(params.ctx)
      : buildLegacyInboundMessageSendingBeforeDeliver(params.ctx);
  const globalBeforeDeliver = composeReplyDispatchBeforeDeliver(
    replyPayloadBeforeDeliver,
    messageSendingBeforeDeliver,
  );
  const composedBeforeDeliver = params.dispatcherOptions.beforeDeliver
    ? composeReplyDispatchBeforeDeliver(
        {
          hook: params.dispatcherOptions.beforeDeliver,
          options: params.dispatcherOptions.beforeDeliverOptions,
        },
        replyPayloadBeforeDeliver,
      )
    : globalBeforeDeliver;
  const dispatcher = createReplyDispatcher({
    ...params.dispatcherOptions,
    beforeDeliver: composedBeforeDeliver,
    silentReplyContext: params.dispatcherOptions.silentReplyContext ?? silentReplyContext,
  });
  markReplyPayloadSendingBeforeDeliverInstalled(dispatcher, replyPayloadBeforeDeliver);
  return await dispatchInboundMessage({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    toolsAllow: params.toolsAllow,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
    replyPayloadRunState,
    onSessionMetadataChanges: params.onSessionMetadataChanges,
  });
}

/** Creates a plain dispatcher, installs global send hooks, and dispatches the inbound message. */
export async function dispatchInboundMessageWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  toolsAllow?: string[];
  replyOptions?: InternalDispatchReplyOptions;
  replyResolver?: InternalGetReplyFromConfig;
}): Promise<DispatchInboundResult> {
  return await dispatchInboundMessageWithPlainDispatcherCore(params, "legacy");
}

type ProjectedOptions = Omit<ReplyDispatcherOptions, "beforeDeliver" | "beforeDeliverOptions">;

/** Creates a core-owned dispatcher whose modifiers fence projected output capture. */
export async function dispatchInboundMessageWithProjectedDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ProjectedOptions;
  toolsAllow?: string[];
  replyOptions?: InternalDispatchReplyOptions;
  replyResolver?: InternalGetReplyFromConfig;
  onSessionMetadataChanges?: (changes: CommandSessionMetadataChange[]) => void;
}): Promise<DispatchInboundResult> {
  return await dispatchInboundMessageWithPlainDispatcherCore(params, "projected");
}
