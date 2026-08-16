// Channel outbound contracts define plugin send results, media handling, and delivery metadata.
import type {
  DurableMessageBatchSendResult,
  DurableMessageSendContext,
  DurableMessageSendContextParams,
} from "../channels/message/runtime.js";
import {
  resolveChannelProgressDraftConfig as readProgressDraftConfig,
  type StreamingCompatEntry as ProgressDraftCompatEntry,
} from "../channels/streaming.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

type ChannelDurableDeliveryModule = typeof import("../channels/turn/durable-delivery.js");
// Share one lazy import across SDK helper calls so plugin barrels do not eagerly pull
// message runtime internals into registration/discovery-only paths.
const loadChannelMessageRuntimeModule = createLazyRuntimeModule(
  () => import("../channels/message/runtime.js"),
);

export type { DurableMessageBatchSendResult } from "../channels/message/runtime.js";
export {
  isRecentOutboundMessageIdentity,
  recordOutboundMessageIdentity,
} from "../channels/message/outbound-echo.js";
export type { OutboundMessageIdentity } from "../channels/message/outbound-echo.js";
export {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  // Narrow drain seam by maintainer decision (#108924): factory, lifecycle binding,
  // tuning constants, and processPidFromOwnerId (telegram transport display). All other
  // claim/retry/adoption internals stay core-owned; test helpers live on the
  // private-local plugin-state-test-runtime subpath.
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
} from "../channels/message/ingress-drain.js";
export {
  CHANNEL_INGRESS_RETENTION_DEFAULTS,
  createChannelIngressError,
  createChannelIngressMonitor,
} from "../channels/message/ingress-monitor.js";
export {
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "../channels/message/ingress-retry-policy.js";
export {
  INGRESS_CLAIM_PROCESS_ID,
  processPidFromOwnerId,
} from "../channels/message/ingress-claim-owner.js";
export {
  createChannelReplyPipeline as createChannelMessageReplyPipeline,
  createReplyPrefixContext,
  createReplyPrefixOptions,
  createTypingCallbacks,
  resolveChannelSourceReplyDeliveryMode as resolveChannelMessageSourceReplyDeliveryMode,
} from "../channels/message/reply-pipeline.js";
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

/** @deprecated The streaming.progress.render key was retired (#122927). */
export type ChannelProgressDraftRenderMode = "rich" | "text";

/**
 * @deprecated Load-only bridge: the published Slack channel package
 * (2026.7.2-beta.7 and earlier) imports this at module top level, so removing
 * it makes the installed plugin fail to load after a core upgrade. The config
 * key it read is retired and doctor strips it, so this resolves the same
 * "text"/"rich" answer pre-doctor configs produced and the default otherwise.
 * Remove once managed releases have replaced the old npm latest/extended-stable
 * packages and their upgrade window has closed.
 */
export function resolveChannelProgressDraftRender(
  entry: ProgressDraftCompatEntry | null | undefined,
  defaultValue: ChannelProgressDraftRenderMode = "text",
): ChannelProgressDraftRenderMode {
  const configured = (readProgressDraftConfig(entry) as { render?: unknown }).render;
  return configured === "rich" || configured === "text" ? configured : defaultValue;
}
export type {
  ChannelProgressDraftCompositorLine,
  ChannelProgressDraftCompositorSnapshot,
} from "../channels/progress-draft-compositor.js";
export { deriveDurableFinalDeliveryRequirements } from "../channels/message/capabilities.js";
export { defineChannelMessageAdapter } from "../channels/message/adapter.js";
export { createChannelMessageAdapterFromOutbound } from "../channels/message/outbound-bridge.js";
export { createDurableInboundReceiveJournalFromQueue } from "../channels/message/durable-receive.js";
export {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
  verifyChannelMessageReceiveAckPolicyAdapterProofs,
  verifyDurableFinalCapabilityProofs,
} from "../channels/message/contracts.js";
export {
  createPreviewMessageReceipt,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
} from "../channels/message/live.js";
export {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  resolveMessageReceiptPrimaryId,
} from "../channels/message/receipt.js";
export { createMessageReceiveContext } from "../channels/message/receive.js";
export type { ChannelIngressDrain } from "../channels/message/ingress-drain.js";
export type {
  ChannelIngressMonitorDeliveryResult,
  ChannelIngressMonitorLifecycle,
} from "../channels/message/ingress-monitor.js";
export type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueClaimRef,
  ChannelIngressQueueCorruptClaim,
  ChannelIngressQueueRecord,
} from "../channels/message/ingress-queue.js";
export type { MessageAckPolicy, MessageReceiveContext } from "../channels/message/receive.js";
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
} from "../channels/message/types.js";

/** Lazily forwards inbound reply delivery through the channel turn durable-delivery module. */
export const deliverInboundReplyWithMessageSendContext: ChannelDurableDeliveryModule["deliverInboundReplyWithMessageSendContextCore"] =
  async (...args) => {
    const mod = await import("../channels/turn/durable-delivery.js");
    return await mod.deliverInboundReplyWithMessageSendContextCore(...args);
  };

/** Sends a durable message batch without eager-loading channel message runtime internals. */
export async function sendDurableMessageBatch(
  /**
   * Durable send context and outbound batch data forwarded to the channel runtime.
   */
  params: DurableMessageSendContextParams,
): Promise<DurableMessageBatchSendResult> {
  const mod = await loadChannelMessageRuntimeModule();
  return await mod.sendDurableMessageBatchCore(params);
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
  return await mod.withDurableMessageSendContextCore(params, run);
}
