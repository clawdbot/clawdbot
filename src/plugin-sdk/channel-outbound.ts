// Channel outbound contracts define plugin send results, media handling, and delivery metadata.
import type {
  DurableMessageBatchSendResult,
  DurableMessageSendContext,
  DurableMessageSendContextParams,
} from "../channels/message/runtime.js";
type ChannelInboundKernelModule = typeof import("../channels/turn/kernel.js");
type ChannelMessageRuntimeModule = typeof import("../channels/message/runtime.js");

let channelMessageRuntimeModulePromise: Promise<ChannelMessageRuntimeModule> | null = null;

const loadChannelMessageRuntimeModule = async () => {
  // Share one lazy import across SDK helper calls so plugin barrels do not eagerly pull
  // message runtime internals into registration/discovery-only paths.
  channelMessageRuntimeModulePromise ??= import("../channels/message/runtime.js");
  return await channelMessageRuntimeModulePromise;
};

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
  createReplyPrefixContext,
  createReplyPrefixOptions,
  createTypingCallbacks,
  createChannelReplyPipeline as createChannelMessageReplyPipeline,
  resolveChannelSourceReplyDeliveryMode as resolveChannelMessageSourceReplyDeliveryMode,
} from "../channels/message/index.js";

export {
  createFinalizableDraftLifecycle,
  createFinalizableDraftStreamControls,
  createFinalizableDraftStreamControlsForState,
  clearFinalizableDraftMessage,
  takeMessageIdAfterStop,
} from "../channels/draft-stream-controls.js";
export type { FinalizableDraftStreamState } from "../channels/draft-stream-controls.js";
export { createDraftStreamLoop } from "../channels/draft-stream-loop.js";
export type { DraftStreamLoop } from "../channels/draft-stream-loop.js";
export { createRuntimeOutboundDelegates } from "../channels/plugins/runtime-forwarders.js";
export { createChannelRunQueue } from "./channel-lifecycle.core.js";
export type {
  ChannelRunQueue,
  ChannelRunQueueParams,
  ChannelRunQueueTaskContext,
} from "./channel-lifecycle.core.js";
export {
  createAccountStatusSink,
  keepHttpServerTaskAlive,
  runPassiveAccountLifecycle,
  waitUntilAbort,
} from "./channel-lifecycle.core.js";
export {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForDelivery,
} from "../infra/outbound/payloads.js";
export {
  buildOutboundSessionContext,
  type OutboundSessionContext,
} from "../infra/outbound/session-context.js";
export type { OutboundDeliveryFormattingOptions } from "../infra/outbound/formatting.js";
export { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
export type { OutboundIdentity } from "../infra/outbound/identity.js";
export { createReplyToFanout } from "../infra/outbound/reply-policy.js";
export type { ReplyToResolution } from "../infra/outbound/reply-policy.js";
export { resolveOutboundSendDep } from "../infra/outbound/send-deps.js";
export type { OutboundSendDeps } from "../infra/outbound/send-deps.js";
export { sanitizeForPlainText } from "../infra/outbound/sanitize-text.js";
export { logAckFailure, logTypingFailure } from "../channels/logging.js";
export * from "../channels/streaming.js";
export * from "../channels/progress-draft-compositor.js";
export {
  classifyDurableSendRecoveryState,
  createChannelMessageAdapterFromOutbound,
  createDurableInboundReceiveJournal,
  createDurableInboundReceiveJournalFromQueue,
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
  defineChannelMessageAdapter,
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
  ChannelMessageSendPollContext,
  ChannelMessageSendResult,
  ChannelMessageSendSuccessContext,
  ChannelMessageSendTextContext,
  ChannelMessageUnknownSendContext,
  ChannelMessageUnknownSendReconciliationResult,
  CreateChannelReplyPipelineParams,
  CreateChannelMessageAdapterFromOutboundParams,
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueClaimRef,
  ChannelIngressQueueCompletedRecord,
  ChannelIngressQueueEnqueueResult,
  ChannelIngressQueueFailedRecord,
  ChannelIngressQueuePruneOptions,
  ChannelIngressQueueRecord,
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
  DurableInboundReceiveAcceptOptions,
  DurableInboundReceiveAcceptResult,
  DurableInboundReceiveCompletedRecord,
  DurableInboundReceiveCompleteOptions,
  DurableInboundReceiveJournal,
  DurableInboundReceiveJournalOptions,
  DurableInboundReceivePendingRecord,
  DurableInboundReceiveQueueJournalOptions,
  DurableInboundReceiveReleaseOptions,
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

/** Lazily forwards inbound reply delivery through the channel turn kernel. */
export const deliverInboundReplyWithMessageSendContext: ChannelInboundKernelModule["deliverInboundReplyWithMessageSendContext"] =
  async (...args) => {
    const mod = await import("../channels/turn/kernel.js");
    return await mod.deliverInboundReplyWithMessageSendContext(...args);
  };

/** Sends a durable message batch without eager-loading channel message runtime internals. */
export async function sendDurableMessageBatch(
  /**
   * Durable send context and outbound batch data forwarded to the channel runtime.
   */
  params: DurableMessageSendContextParams,
): Promise<DurableMessageBatchSendResult> {
  const mod = await loadChannelMessageRuntimeModule();
  return await mod.sendDurableMessageBatch(params);
}

/** Runs work inside a durable message send context loaded through the SDK lazy boundary. */
export async function withDurableMessageSendContext<T>(
  /**
   * Durable send context used to bind sends, receipts, and lifecycle callbacks.
   */
  params: DurableMessageSendContextParams,
  /**
   * Callback executed with the loaded durable-send runtime context.
   */
  run: (ctx: DurableMessageSendContext) => Promise<T>,
): Promise<T> {
  const mod = await loadChannelMessageRuntimeModule();
  return await mod.withDurableMessageSendContext(params, run);
}
