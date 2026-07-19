// Channel outbound contracts define plugin send results, media handling, and delivery metadata.
import type {
  DurableMessageBatchSendResult,
  DurableMessageSendContext,
  DurableMessageSendContextParams,
} from "../channels/message/runtime.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

type ChannelInboundKernelModule = typeof import("../channels/turn/kernel.js");
// Share one lazy import across SDK helper calls so plugin barrels do not eagerly pull
// message runtime internals into registration/discovery-only paths.
const loadChannelMessageRuntimeModule = createLazyRuntimeModule(
  () => import("../channels/message/runtime.js"),
);

export type { DurableMessageBatchSendResult } from "../channels/message/runtime.js";
export {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  createChannelIngressMonitor,
  createReplyPrefixContext,
  createReplyPrefixOptions,
  createTypingCallbacks,
  createChannelReplyPipeline as createChannelMessageReplyPipeline,
  // Narrow drain seam by maintainer decision (#108924): factory, lifecycle binding,
  // tuning constants, and processPidFromOwnerId (telegram transport display). All other
  // claim/retry/adoption internals stay core-owned; test helpers live on the
  // private-local plugin-state-test-runtime subpath.
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  INGRESS_CLAIM_PROCESS_ID,
  processPidFromOwnerId,
  resolveChannelSourceReplyDeliveryMode as resolveChannelMessageSourceReplyDeliveryMode,
} from "../channels/message/index.js";
// Bare interval/stop orchestration for channels that own their typing renewal
// policy (e.g. per-message reply budgets) instead of the createTypingCallbacks lifecycle.
export { createTypingKeepaliveLoop } from "../channels/typing-lifecycle.js";

export {
  createFinalizableDraftLifecycle,
  createFinalizableDraftStreamControlsForState,
  takeMessageIdAfterStop,
} from "../channels/draft-stream-controls.js";

export { createDraftStreamLoop } from "../channels/draft-stream-loop.js";

export { resolveChannelDraftStreamingChunking } from "../channels/draft-streaming-chunking.js";
export type { ChannelDraftStreamingChunking } from "../channels/draft-streaming-chunking.js";
export { createRuntimeOutboundDelegates } from "../channels/plugins/runtime-forwarders.js";
export { createChannelRunQueue } from "./channel-lifecycle.core.js";

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
export { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
export type { OutboundSessionContext } from "../infra/outbound/session-context.js";
export type { OutboundDeliveryFormattingOptions } from "../infra/outbound/formatting.js";
export { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
export type { OutboundIdentity } from "../infra/outbound/identity.js";
export { createReplyToFanout } from "../infra/outbound/reply-policy.js";
export type { ReplyToResolution } from "../infra/outbound/reply-policy.js";
export { resolveOutboundSendDep } from "../infra/outbound/send-deps.js";
export type { OutboundSendDeps } from "../infra/outbound/send-deps.js";
export { sanitizeForPlainText } from "../infra/outbound/sanitize-text.js";
export { logTypingFailure } from "../channels/logging.js";
export {
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
  createChannelProgressDraftGate,
  formatChannelProgressDraftLine,
  formatChannelProgressDraftLineForEntry,
  formatChannelProgressDraftText,
  getChannelStreamingConfigObject,
  isChannelProgressDraftWorkToolName,
  isPotentialTruncatedFinal,
  formatPlanChecklistLines,
  mergeChannelProgressDraftLine,
  normalizeAgentPlanSteps,
  normalizeChannelProgressDraftLineIdentity,
  resolveChannelPreviewStreamMode,
  resolveChannelProgressDraftConfig,
  resolveChannelProgressDraftMaxLineChars,
  resolveChannelProgressDraftMaxLines,
  resolveChannelProgressDraftRender,
  resolveChannelStreamingBlockCoalesce,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingChunkMode,
  resolveChannelStreamingNativeTransport,
  resolveChannelStreamingPreviewCommandText,
  resolveChannelStreamingPreviewToolProgress,
  resolveChannelStreamingProgressCommentary,
  resolveChannelStreamingProgressNarration,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
  resolveTranscriptBackedChannelFinalText,
  selectLongerFinalText,
} from "../channels/streaming.js";
export type {
  AgentPlanStep,
  AgentPlanStepStatus,
  ChannelDeliveryStreamingConfig,
  ChannelPreviewStreamingConfig,
  ChannelProgressDraftLine,
  ChannelStreamingBlockConfig,
  ChannelStreamingProgressConfig,
  StreamingMode,
  TextChunkMode,
} from "../channels/streaming.js";
export {
  createChannelProgressDraftCompositor,
  createChannelProgressReceiptTracker,
} from "../channels/progress-draft-compositor.js";
export type {
  ChannelProgressDraftCompositorLine,
  ChannelProgressDraftCompositorSnapshot,
} from "../channels/progress-draft-compositor.js";
export {
  createChannelMessageAdapterFromOutbound,
  createDurableInboundReceiveJournalFromQueue,
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  createMessageReceiveContext,
  createPreviewMessageReceipt,
  defineFinalizableLivePreviewAdapter,
  deriveDurableFinalDeliveryRequirements,
  deliverWithFinalizableLivePreviewAdapter,
  defineChannelMessageAdapter,
  resolveMessageReceiptPrimaryId,
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
  verifyChannelMessageReceiveAckPolicyAdapterProofs,
  verifyDurableFinalCapabilityProofs,
} from "../channels/message/index.js";
export type {
  ChannelMessageAdapterShape,
  ChannelMessageDurableFinalAdapter,
  ChannelMessageSendMediaContext,
  ChannelMessageSendPayloadContext,
  ChannelMessageSendResult,
  ChannelMessageSendTextContext,
  ChannelMessageUnknownSendContext,
  ChannelMessageUnknownSendReconciliationResult,
  ChannelIngressDrain,
  ChannelIngressMonitorDeliveryResult,
  ChannelIngressMonitorLifecycle,
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueClaimRef,
  ChannelIngressQueueCorruptClaim,
  ChannelIngressQueueRecord,
  MessageAckPolicy,
  MessageReceiveContext,
  MessageReceipt,
  MessageReceiptPart,
  MessageReceiptPartKind,
  MessageReceiptSourceResult,
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
