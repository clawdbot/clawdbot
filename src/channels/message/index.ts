// Public barrel for channel message delivery, live preview, receipt, receive, and recovery
// contracts used by channel plugins and core delivery code.
export { deriveDurableFinalDeliveryRequirements } from "./capabilities.js";
export { defineChannelMessageAdapter } from "./adapter.js";
export { createChannelMessageAdapterFromOutbound } from "./outbound-bridge.js";
export { createDurableInboundReceiveJournalFromQueue } from "./durable-receive.js";
export { INGRESS_CLAIM_PROCESS_ID, processPidFromOwnerId } from "./ingress-claim-owner.js";
export {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
} from "./ingress-drain.js";
export { createChannelIngressMonitor } from "./ingress-monitor.js";
export {
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "./ingress-retry-policy.js";

export {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
  verifyChannelMessageReceiveAckPolicyAdapterProofs,
  verifyDurableFinalCapabilityProofs,
} from "./contracts.js";
export {
  createPreviewMessageReceipt,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
} from "./live.js";
export {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  resolveMessageReceiptPrimaryId,
} from "./receipt.js";
export { createMessageReceiveContext } from "./receive.js";
export {
  createChannelReplyPipeline,
  createReplyPrefixContext,
  createReplyPrefixOptions,
  createTypingCallbacks,
  resolveChannelSourceReplyDeliveryMode,
} from "./reply-pipeline.js";
export type { ChannelIngressDrain } from "./ingress-drain.js";
export type {
  ChannelIngressMonitorDeliveryResult,
  ChannelIngressMonitorLifecycle,
} from "./ingress-monitor.js";
export type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueClaimRef,
  ChannelIngressQueueCorruptClaim,
  ChannelIngressQueueRecord,
} from "./ingress-queue.js";
export type { MessageAckPolicy, MessageReceiveContext } from "./receive.js";
export type {
  ChannelMessageAdapterShape,
  ChannelMessageDurableFinalAdapter,
  ChannelMessageSendMediaContext,
  ChannelMessageSendPayloadContext,
  ChannelMessageSendResult,
  ChannelMessageSendTextContext,
  ChannelMessageUnknownSendContext,
  ChannelMessageUnknownSendReconciliationResult,
  MessageReceipt,
  MessageReceiptPart,
  MessageReceiptPartKind,
  MessageReceiptSourceResult,
} from "./types.js";
