// Shared type contracts for outbound planning, queueing, and transport.
import type { ReplyPayload } from "../../auto-reply/types.js";
import type {
  ChannelDeliveryCapabilities,
  ChannelOutboundAdapter,
  ChannelOutboundTargetRef,
} from "../../channels/plugins/types.adapters.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayloadDeliveryPin } from "../../interactive/payload.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import type { OutboundDeliveryResult, OutboundPayloadDeliveryOutcome } from "./deliver-types.js";
import type { DurableDeliveryCompletion } from "./delivery-completion.js";
import type {
  QueuedReplyPayloadSendingHook,
  QueuedRenderedMessageBatchPlan,
} from "./delivery-queue.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { OutboundIdentity } from "./identity.js";
import type { OutboundMessageSendOverrides } from "./message-plan.js";
import type { DeliveryMirror } from "./mirror.js";
import type { NormalizedOutboundPayload } from "./payloads.js";
import type { OutboundSendDeps } from "./send-deps.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";

export type OutboundDeliveryQueuePolicy = "required" | "best_effort";

export type OutboundDeliveryIntent = {
  id: string;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  queuePolicy: OutboundDeliveryQueuePolicy;
};

export type DurableFinalDeliveryRequirement = keyof NonNullable<
  ChannelDeliveryCapabilities["durableFinal"]
>;

export type DurableFinalDeliveryRequirements = Partial<
  Record<DurableFinalDeliveryRequirement, boolean>
>;

export type OutboundDurableDeliverySupport =
  | { ok: true }
  | {
      ok: false;
      reason: "missing_outbound_handler" | "capability_mismatch";
      capability?: DurableFinalDeliveryRequirement;
    };

export type NormalizedPayloadForChannelDelivery = {
  index: number;
  payload: ReplyPayload;
};

export type ChannelHandler = {
  chunker: ChannelOutboundAdapter["chunker"] | null;
  chunkerMode?: "text" | "markdown";
  chunkedTextFormatting?: OutboundDeliveryFormattingOptions;
  textChunkLimit?: number;
  supportsMedia: boolean;
  sanitizeText?: (payload: ReplyPayload) => string;
  normalizePayload?: (payload: ReplyPayload) => ReplyPayload | null;
  normalizePayloadBatch?: (
    payloads: NormalizedPayloadForChannelDelivery[],
  ) => NormalizedPayloadForChannelDelivery[];
  sendTextOnlyErrorPayloads?: boolean;
  renderPresentation?: (payload: ReplyPayload) => Promise<ReplyPayload | null>;
  presentationCapabilities?: ChannelOutboundAdapter["presentationCapabilities"];
  pinDeliveredMessage?: (params: {
    target: ChannelOutboundTargetRef;
    messageId: string;
    pin: ReplyPayloadDeliveryPin;
    gatewayClientScopes?: readonly string[];
  }) => Promise<void>;
  afterDeliverPayload?: (params: {
    target: ChannelOutboundTargetRef;
    payload: ReplyPayload;
    results: readonly OutboundDeliveryResult[];
  }) => Promise<void>;
  buildTargetRef: (overrides?: { threadId?: string | number | null }) => ChannelOutboundTargetRef;
  shouldSkipPlainTextSanitization?: (payload: ReplyPayload) => boolean;
  resolveEffectiveTextChunkLimit?: (fallbackLimit?: number) => number | undefined;
  sendPayload?: (
    payload: ReplyPayload,
    overrides?: OutboundMessageSendOverrides,
  ) => Promise<OutboundDeliveryResult>;
  sendFormattedText?: (
    text: string,
    overrides?: OutboundMessageSendOverrides,
  ) => Promise<OutboundDeliveryResult[]>;
  sendFormattedMedia?: (
    caption: string,
    mediaUrl: string,
    overrides?: OutboundMessageSendOverrides,
  ) => Promise<OutboundDeliveryResult>;
  sendText: (
    text: string,
    overrides?: OutboundMessageSendOverrides,
  ) => Promise<OutboundDeliveryResult>;
  sendMedia: (
    caption: string,
    mediaUrl: string,
    overrides?: OutboundMessageSendOverrides,
  ) => Promise<OutboundDeliveryResult>;
};

export type PlatformSendRoute = {
  replyToId?: string | null;
  threadId?: string | number | null;
};

export type ChannelHandlerParams = {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  formatting?: OutboundDeliveryFormattingOptions;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  silent?: boolean;
  mediaAccess?: OutboundMediaAccess;
  gatewayClientScopes?: readonly string[];
  conversationReadOrigin?: "delegated" | "direct-operator";
  deliveryQueueId?: string;
  preparedMessageId?: string;
  requiredUnknownSendReconciliation?: boolean;
  onPlatformSendStart?: (route: PlatformSendRoute) => Promise<void>;
  onPlatformSendDispatch?: () => Promise<void>;
  onDeliveryResult?: (result: OutboundDeliveryResult) => Promise<void> | void;
};

export type DeliverOutboundPayloadsCoreParams = {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  payloads: ReplyPayload[];
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  formatting?: OutboundDeliveryFormattingOptions;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  mediaAccess?: OutboundMediaAccess;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  replyPayloadSendingHook?: QueuedReplyPayloadSendingHook;
  abortSignal?: AbortSignal;
  bestEffort?: boolean;
  onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
  onPayload?: (payload: NormalizedOutboundPayload) => void;
  /** @internal Reports the effective payload only after an identified platform send. */
  onDeliveredPayload?: (payload: NormalizedOutboundPayload) => void;
  onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
  /** @internal Runs after each identified platform result, before further fallible work. */
  onDeliveryResult?: (result: OutboundDeliveryResult) => Promise<void> | void;
  /** @internal Persists ambiguous-send state immediately before platform I/O. */
  onPlatformSendStart?: (route: PlatformSendRoute) => Promise<void>;
  /** @internal Opaque durable intent id forwarded to provider reconciliation hooks. */
  deliveryQueueId?: string;
  /** @internal Stable producer id used to make queue creation idempotent across crashes. */
  deliveryIntentId?: string;
  /** @internal Serializable owner state finalized after live or recovered delivery. */
  deliveryCompletion?: DurableDeliveryCompletion;
  /** @internal Channel-valid id reserved before a correlated conversation turn is sent. */
  preparedMessageId?: string;
  /** @internal Recheck the concrete post-hook send shape before platform I/O. */
  requiredUnknownSendReconciliation?: boolean;
  /** @internal Caller preflight explicitly required provider unknown-send reconciliation. */
  requireUnknownSendReconciliation?: boolean;
  /** @internal Refresh durable timing before recipient-visible or finalizing platform I/O. */
  onPlatformSendDispatch?: () => Promise<void>;
  /** Session/agent context used for hooks and media local-root scoping. */
  session?: OutboundSessionContext;
  mirror?: DeliveryMirror;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
  conversationReadOrigin?: "delegated" | "direct-operator";
};

/**
 * @deprecated Direct outbound delivery is compatibility/runtime substrate.
 * New message lifecycle code should use `sendDurableMessageBatch` from
 * `src/channels/message/send.ts` or `deliverInboundReplyWithMessageSendContext`
 * from `src/channels/turn/durable-delivery.ts`. Keep direct use only for
 * outbound substrate, recovery, and compatibility paths.
 */
export type DeliverOutboundPayloadsParams = DeliverOutboundPayloadsCoreParams & {
  /** @internal Skip write-ahead queue (used by crash-recovery to avoid re-enqueueing). */
  skipQueue?: boolean;
  /** @internal Recovery already ran provider admission after its pending-row re-read. */
  deferredDeliveryAdmissionPassed?: true;
  /** @internal State directory that owns the existing recovery queue entry. */
  deliveryQueueStateDir?: string;
  /** @internal Let recovery run commit hooks after it has acked the recovered queue entry. */
  deferCommitHooks?: boolean;
  queuePolicy?: OutboundDeliveryQueuePolicy;
  renderedBatchPlan?: QueuedRenderedMessageBatchPlan;
  onDeliveryIntent?: (intent: OutboundDeliveryIntent) => void;
};
