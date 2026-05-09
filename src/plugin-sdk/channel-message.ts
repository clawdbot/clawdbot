import type {
  ChannelMessageAdapter,
  ChannelMessageAdapterShape,
} from "../channels/message/index.js";
import type { ChannelMessageReceiveAdapterShape } from "../channels/message/index.js";
import type {
  DurableMessageBatchSendParams,
  DurableMessageBatchSendResult,
  DurableMessageSendContext,
  DurableMessageSendContextParams,
} from "../channels/message/runtime.js";
import {
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatch,
  resolveChannelTurnDispatchCounts,
} from "../channels/turn/dispatch-result.js";
import {
  createChannelReplyPipeline,
  type CreateChannelReplyPipelineParams,
} from "./channel-reply-core.js";
export type {
  DurableInboundReplyDeliveryOptions,
  DurableInboundReplyDeliveryParams,
  DurableInboundReplyDeliveryResult,
} from "../channels/turn/kernel.js";
export type {
  DurableMessageBatchSendParams,
  DurableMessageBatchSendResult,
  DurableMessageSendContext,
  DurableMessageSendContextParams,
} from "../channels/message/runtime.js";
export {
  createChannelReplyPipeline as createChannelMessageReplyPipeline,
  createReplyPrefixContext,
  createReplyPrefixOptions,
  createTypingCallbacks,
  resolveChannelSourceReplyDeliveryMode as resolveChannelMessageSourceReplyDeliveryMode,
} from "./channel-reply-core.js";

export {
  classifyDurableSendRecoveryState,
  createChannelMessageAdapterFromOutbound,
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  createMessageReceiveContext,
  createPreviewMessageReceipt,
  defineFinalizableLivePreviewAdapter,
  deriveDurableFinalDeliveryRequirements,
  deliverFinalizableLivePreview,
  deliverWithFinalizableLivePreviewAdapter,
  listDeclaredChannelMessageLiveCapabilities,
  listDeclaredDurableFinalCapabilities,
  listDeclaredLivePreviewFinalizerCapabilities,
  listDeclaredReceiveAckPolicies,
  createLiveMessageState,
  createDurableMessageStateRecord,
  markLiveMessageCancelled,
  markLiveMessageFinalized,
  markLiveMessagePreviewUpdated,
  resolveMessageReceiptPrimaryId,
  shouldAckMessageAfterStage,
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveCapabilityProofs,
  verifyChannelMessageLiveFinalizerProofs,
  verifyChannelMessageReceiveAckPolicyAdapterProofs,
  verifyChannelMessageReceiveAckPolicyProofs,
  verifyDurableFinalCapabilityProofs,
  verifyLivePreviewFinalizerCapabilityProofs,
} from "../channels/message/index.js";
export type {
  ChannelMessageAdapter,
  ChannelMessageAdapterShape,
  ChannelMessageDurableFinalAdapter,
  ChannelMessageLiveFinalizerAdapterShape,
  ChannelMessageLiveAdapterShape,
  ChannelMessageLiveCapability,
  ChannelMessageOutboundBridgeAdapter,
  ChannelMessageOutboundBridgeResult,
  ChannelMessageReceiveAckPolicy,
  ChannelMessageReceiveAdapterShape,
  ChannelMessageSendAdapter,
  ChannelMessageSendAttemptContext,
  ChannelMessageSendAttemptKind,
  ChannelMessageSendCommitContext,
  ChannelMessageSendFailureContext,
  ChannelMessageSendLifecycleAdapter,
  ChannelMessageSendMediaContext,
  ChannelMessageSendPayloadContext,
  ChannelMessageSendResult,
  ChannelMessageSendSuccessContext,
  ChannelMessageSendTextContext,
  ChannelMessageUnknownSendContext,
  ChannelMessageUnknownSendReconciliationResult,
  CreateChannelReplyPipelineParams,
  CreateChannelMessageAdapterFromOutboundParams,
  DeriveDurableFinalDeliveryRequirementsParams,
  ChannelMessageLiveCapabilityProof,
  ChannelMessageLiveCapabilityProofMap,
  ChannelMessageLiveCapabilityProofResult,
  ChannelMessageReceiveAckPolicyProof,
  ChannelMessageReceiveAckPolicyProofMap,
  ChannelMessageReceiveAckPolicyProofResult,
  DurableFinalCapabilityProof,
  DurableFinalCapabilityProofMap,
  DurableFinalCapabilityProofResult,
  DurableFinalDeliveryCapability,
  DurableFinalDeliveryPayloadShape,
  DurableFinalDeliveryRequirementMap,
  DurableFinalRequirementExtras,
  DurableMessageSendIntent,
  DurableMessageSendState,
  DurableMessageStateRecord,
  FinalizableLivePreviewAdapter,
  LiveMessagePhase,
  LiveMessageState,
  LivePreviewFinalizerCapability,
  LivePreviewFinalizerCapabilityMap,
  LivePreviewFinalizerDraft,
  LivePreviewFinalizerCapabilityProof,
  LivePreviewFinalizerCapabilityProofMap,
  LivePreviewFinalizerCapabilityProofResult,
  LivePreviewFinalizerResult,
  LivePreviewFinalizerResultKind,
  MessageAckPolicy,
  MessageAckStage,
  MessageAckState,
  MessageReceiveContext,
  MessageSendContext,
  MessageDurabilityPolicy,
  MessageReceipt,
  MessageReceiptPart,
  MessageReceiptPartKind,
  MessageReceiptSourceResult,
  RenderedMessageBatch,
  RenderedMessageBatchPlan,
  RenderedMessageBatchPlanItem,
  RenderedMessageBatchPlanKind,
} from "../channels/message/index.js";

export {
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatch,
  resolveChannelTurnDispatchCounts,
};

type ChannelTurnKernelModule = typeof import("../channels/turn/kernel.js");
type InboundReplyDispatchModule = typeof import("./inbound-reply-dispatch.js");

/** @deprecated Use `createChannelMessageReplyPipeline(...)` for compatibility dispatchers. */
export function createChannelTurnReplyPipeline(params: CreateChannelReplyPipelineParams) {
  return createChannelReplyPipeline(params);
}

/** @deprecated Compatibility helper for legacy reply dispatch results. */
export const hasFinalChannelMessageReplyDispatch = hasFinalChannelTurnDispatch;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export const hasVisibleChannelMessageReplyDispatch = hasVisibleChannelTurnDispatch;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export const resolveChannelMessageReplyDispatchCounts = resolveChannelTurnDispatchCounts;

/** @deprecated Compatibility helper for legacy reply dispatch bridges. */
export const buildChannelMessageReplyDispatchBase: InboundReplyDispatchModule["buildChannelMessageReplyDispatchBase"] =
  ((params) => ({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    agentId: params.route.agentId,
    routeSessionKey: params.route.sessionKey,
    storePath: params.storePath,
    ctxPayload: params.ctxPayload,
    recordInboundSession: params.core.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      params.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
  })) as InboundReplyDispatchModule["buildChannelMessageReplyDispatchBase"];

/**
 * @deprecated Compatibility reply-dispatch bridge. New channel plugins should
 * expose a `message` adapter and route sends through
 * `deliverInboundReplyWithMessageSendContext(...)` or
 * `sendDurableMessageBatch(...)`.
 */
export const dispatchChannelMessageReplyWithBase: InboundReplyDispatchModule["dispatchChannelMessageReplyWithBase"] =
  async (...args) => {
    const mod = await import("./inbound-reply-dispatch.js");
    return await mod.dispatchChannelMessageReplyWithBase(...args);
  };

/**
 * @deprecated Compatibility reply-dispatch bridge. New channel plugins should
 * expose a `message` adapter and route sends through
 * `deliverInboundReplyWithMessageSendContext(...)` or
 * `sendDurableMessageBatch(...)`.
 */
export const recordChannelMessageReplyDispatch: InboundReplyDispatchModule["recordChannelMessageReplyDispatch"] =
  async (...args) => {
    const mod = await import("./inbound-reply-dispatch.js");
    return await mod.recordChannelMessageReplyDispatch(...args);
  };

export const deliverInboundReplyWithMessageSendContext: ChannelTurnKernelModule["deliverInboundReplyWithMessageSendContext"] =
  async (...args) => {
    const mod = await import("../channels/turn/kernel.js");
    return await mod.deliverInboundReplyWithMessageSendContext(...args);
  };

/** @deprecated Use `deliverInboundReplyWithMessageSendContext`. */
export const deliverDurableInboundReplyPayload = deliverInboundReplyWithMessageSendContext;

export async function sendDurableMessageBatch(
  params: DurableMessageBatchSendParams,
): Promise<DurableMessageBatchSendResult> {
  const mod = await import("../channels/message/runtime.js");
  return await mod.sendDurableMessageBatch(params);
}

export async function withDurableMessageSendContext<T>(
  params: DurableMessageSendContextParams,
  run: (ctx: DurableMessageSendContext) => Promise<T>,
): Promise<T> {
  const mod = await import("../channels/message/runtime.js");
  return await mod.withDurableMessageSendContext(params, run);
}

const defaultManualReceiveAdapter = {
  defaultAckPolicy: "manual",
  supportedAckPolicies: ["manual"],
} as const satisfies ChannelMessageReceiveAdapterShape;

type ChannelMessageAdapterWithDefaultReceive<TAdapter extends ChannelMessageAdapterShape> =
  TAdapter & {
    receive: TAdapter["receive"] extends undefined
      ? typeof defaultManualReceiveAdapter
      : NonNullable<TAdapter["receive"]>;
  };

export function defineChannelMessageAdapter<const TAdapter extends ChannelMessageAdapterShape>(
  adapter: TAdapter,
): ChannelMessageAdapter<ChannelMessageAdapterWithDefaultReceive<TAdapter>> {
  return {
    ...adapter,
    receive: adapter.receive ?? defaultManualReceiveAdapter,
  } as ChannelMessageAdapter<ChannelMessageAdapterWithDefaultReceive<TAdapter>>;
}
