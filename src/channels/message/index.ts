// Public barrel for channel message delivery, live preview, receipt, receive, and recovery
// contracts used by channel plugins and core delivery code.
export { deriveDurableFinalDeliveryRequirements } from "./capabilities.js";
export { defineChannelMessageAdapter } from "./adapter.js";
export { createChannelMessageAdapterFromOutbound } from "./outbound-bridge.js";
export { createDurableInboundReceiveJournalFromQueue } from "./durable-receive.js";

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
