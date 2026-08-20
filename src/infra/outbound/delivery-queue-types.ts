// Type-only outbound delivery queue contracts shared by storage and failure lifecycle owners.
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type {
  ChannelMessageUnknownSendReconciliationResult,
  OutboundReplyFacts,
  RenderedMessageBatchPlanItem,
} from "../../channels/message/types.js";
import type { ReplyToMode } from "../../config/types.js";
import type { PluginHookReplyPayloadSendingContext } from "../../plugins/hook-types.js";
import type { DeliveryQueueCompletionRetention } from "../delivery-queue-sqlite.js";
import type { DurableDeliveryCompletion } from "./delivery-completion.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { OutboundIdentity } from "./identity.js";
import type { DeliveryMirror } from "./mirror.js";
import type { PreparedOutboundBatch } from "./prepared-batch.js";
import type { OutboundSessionContext } from "./session-context.js";

export type QueuedRenderedMessageBatchPlan = {
  payloadCount: number;
  textCount: number;
  mediaCount: number;
  voiceCount: number;
  presentationCount: number;
  interactiveCount: number;
  channelDataCount: number;
  items: readonly RenderedMessageBatchPlanItem[];
};

export type QueuedReplyPayloadSendingHook = {
  kind: ReplyDispatchKind;
  channel?: string;
  sessionKey?: string;
  runId?: string;
  context: PluginHookReplyPayloadSendingContext;
};

export type QueuedDeliveryPayload = {
  channel: string;
  to: string;
  accountId?: string;
  queuePolicy?: "required" | "best_effort";
  requireUnknownSendReconciliation?: boolean;
  requiresProducerClaim?: boolean;
  preparedBatch?: PreparedOutboundBatch;
  payloads?: ReplyPayload[];
  renderedBatchPlan?: QueuedRenderedMessageBatchPlan;
  threadId?: string | number | null;
  reply?: OutboundReplyFacts;
  formatting?: OutboundDeliveryFormattingOptions;
  identity?: OutboundIdentity;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  silent?: boolean;
  mirror?: DeliveryMirror;
  session?: OutboundSessionContext;
  gatewayClientScopes?: readonly string[];
  preparedMessageId?: string;
  deliveryCompletion?: DurableDeliveryCompletion;
  completionRetention?: DeliveryQueueCompletionRetention;
  legacyUnknownSendReconciliation?: Exclude<
    ChannelMessageUnknownSendReconciliationResult,
    { status: "unresolved" }
  >;
  legacyPreparedContentUnavailable?: true;
  maxRetries?: number;
};

type LegacyQueuedDeliveryPayload = Omit<QueuedDeliveryPayload, "preparedBatch" | "payloads"> & {
  payloads: ReplyPayload[];
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  replyPayloadSendingHook?: QueuedReplyPayloadSendingHook;
};

export interface LegacyQueuedDelivery extends LegacyQueuedDeliveryPayload {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  attemptCount: number;
  availableAt?: number;
  producerClaimId?: string;
  lastAttemptAt?: number;
  lastError?: string;
  platformSendAttemptId?: string;
  platformSendStartedAt?: number;
  effectiveReplyToId?: string | null;
  recoveryState?: "producer_claimed" | "send_attempt_started" | "unknown_after_send";
}

export type LegacyQueuedDeliveryPreparation = LegacyQueuedDelivery & {
  legacyPreparationState: "claimed" | "modifiers_started";
  retainOnFailure?: true;
  legacyPreparationOwnerId?: string;
  legacyPreparationLeaseExpiresAt?: number;
};

export type QueuedDelivery = Omit<QueuedDeliveryPayload, "preparedBatch" | "payloads"> & {
  preparedBatch: PreparedOutboundBatch;
  id: string;
  enqueuedAt: number;
  retryCount: number;
  attemptCount: number;
  availableAt?: number;
  producerClaimId?: string;
  lastAttemptAt?: number;
  lastError?: string;
  platformSendAttemptId?: string;
  platformSendStartedAt?: number;
  effectiveReplyToId?: string | null;
  recoveryState?: "producer_claimed" | "send_attempt_started" | "unknown_after_send";
  retainOnFailure?: true;
};
