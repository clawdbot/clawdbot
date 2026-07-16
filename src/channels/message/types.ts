/**
 * Channel message adapter and durability types.
 *
 * Defines receipts, live-message state, send contexts, and adapter capability contracts.
 */
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundSendDeps } from "../../infra/outbound/send-deps.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import type { PollInput } from "../../polls.js";

/** Delivery durability requested by core when a channel sends agent output. */
export type MessageDurabilityPolicy = "required" | "best_effort" | "disabled";

/** Capability names a channel must advertise before core can rely on durable final delivery. */
export const durableFinalDeliveryCapabilities = [
  "text",
  "media",
  "poll",
  "payload",
  "silent",
  "replyTo",
  "thread",
  "nativeQuote",
  "messageSendingHooks",
  "batch",
  "reconcileUnknownSend",
  "afterSendSuccess",
  "afterCommit",
] as const;

/** Durable final delivery capability key understood by message-channel adapters. */
export type DurableFinalDeliveryCapability = (typeof durableFinalDeliveryCapabilities)[number];

/** Capability map used by adapters to declare which final-send guarantees they support. */
export type DurableFinalDeliveryRequirementMap = Partial<
  Record<DurableFinalDeliveryCapability, boolean>
>;

/** Minimal payload facts used to derive required durable-delivery capabilities. */
type DurableFinalDeliveryPayloadShape = {
  text?: string | null;
  replyToId?: string | null;
  mediaUrl?: string | null;
  mediaUrls?: readonly (string | null | undefined)[] | null;
};

/** Raw platform result shape normalized into a message receipt. */
export type MessageReceiptSourceResult = {
  channel?: string;
  messageId?: string;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  toJid?: string;
  pollId?: string;
  timestamp?: number;
  meta?: Record<string, unknown>;
};

/** Logical part kind for multi-part rendered messages. */
export type MessageReceiptPartKind =
  | "text"
  | "media"
  | "voice"
  | "poll"
  | "card"
  | "preview"
  | "unknown";

/** One platform message produced by a logical outbound send. */
export type MessageReceiptPart = {
  platformMessageId: string;
  kind: MessageReceiptPartKind;
  index: number;
  threadId?: string;
  replyToId?: string;
  raw?: MessageReceiptSourceResult;
};

/** Normalized receipt for all platform messages that make up a logical send. */
export type MessageReceipt = {
  primaryPlatformMessageId?: string;
  platformMessageIds: string[];
  parts: MessageReceiptPart[];
  threadId?: string;
  replyToId?: string;
  editToken?: string;
  deleteToken?: string;
  sentAt: number;
  raw?: readonly MessageReceiptSourceResult[];
};

/** Render-plan item category used before adapter-specific send execution. */
export type RenderedMessageBatchPlanKind =
  | "text"
  | "media"
  | "voice"
  | "presentation"
  | "interactive"
  | "channelData"
  | "empty";

/** Render plan for a single reply payload after text/media/presentation splitting. */
export type RenderedMessageBatchPlanItem = {
  index: number;
  kinds: readonly RenderedMessageBatchPlanKind[];
  text?: string;
  mediaUrls: readonly string[];
  audioAsVoice?: boolean;
  presentationBlockCount?: number;
  hasInteractive?: boolean;
  hasChannelData?: boolean;
};

/** Aggregate render plan for a batch of reply payloads. */
export type RenderedMessageBatchPlan = {
  payloadCount: number;
  textCount: number;
  mediaCount: number;
  voiceCount: number;
  presentationCount: number;
  interactiveCount: number;
  channelDataCount: number;
  items: readonly RenderedMessageBatchPlanItem[];
};

/** Rendered payload batch paired with the plan core uses for send routing and recovery. */
export type RenderedMessageBatch<TPayload = unknown> = {
  payloads: TPayload[];
  plan: RenderedMessageBatchPlan;
};

/** Lifecycle phase for a live preview or streaming message send. */
type LiveMessagePhase = "idle" | "previewing" | "finalizing" | "finalized" | "cancelled";

/** Mutable state snapshot for live preview/finalization flows. */
export type LiveMessageState<TPayload = unknown> = {
  phase: LiveMessagePhase;
  canFinalizeInPlace: boolean;
  receipt?: MessageReceipt;
  lastRendered?: RenderedMessageBatch<TPayload>;
};

/** Durable send context passed through render, preview, send, edit, commit, and failure steps. */
export type MessageSendContext<TPayload = unknown, TSendResult = unknown> = {
  id: string;
  channel: string;
  to: string;
  accountId?: string;
  durability: Exclude<MessageDurabilityPolicy, "disabled">;
  attempt: number;
  signal: AbortSignal;
  intent?: DurableMessageSendIntent;
  previousReceipt?: MessageReceipt;
  preview?: LiveMessageState<TPayload>;
  render(): Promise<RenderedMessageBatch<TPayload>>;
  previewUpdate(rendered: RenderedMessageBatch<TPayload>): Promise<LiveMessageState<TPayload>>;
  send(rendered: RenderedMessageBatch<TPayload>): Promise<TSendResult>;
  edit(receipt: MessageReceipt, rendered: RenderedMessageBatch<TPayload>): Promise<MessageReceipt>;
  delete(receipt: MessageReceipt): Promise<void>;
  commit(receipt: MessageReceipt): Promise<void>;
  fail(error: unknown): Promise<void>;
};

/** Common text-send context shared by text, media, payload, and poll adapter calls. */
export type ChannelMessageSendTextContext<TConfig = OpenClawConfig> = {
  cfg: TConfig;
  to: string;
  text: string;
  accountId?: string | null;
  deps?: OutboundSendDeps;
  replyToId?: string | null;
  replyToIdSource?: "explicit" | "implicit";
  replyToMode?: ReplyToMode;
  threadId?: string | number | null;
  silent?: boolean;
  signal?: AbortSignal;
  gatewayClientScopes?: readonly string[];
  /** @internal Opaque durable intent id for exact provider-side send reconciliation. */
  deliveryQueueId?: string;
  /** @internal Stable platform-send index within one durable payload. */
  deliveryPartIndex?: number;
  /** @internal Refresh durable timing before recipient-visible or finalizing platform I/O. */
  onPlatformSendDispatch?: () => Promise<void>;
  /** @internal Report each completed platform sub-send before another fallible step. */
  onDeliveryResult?: (result: ChannelMessageSendResult) => Promise<void> | void;
};

/** Media send context with validated access hooks and media presentation hints. */
export type ChannelMessageSendMediaContext<TConfig = OpenClawConfig> =
  ChannelMessageSendTextContext<TConfig> & {
    mediaUrl: string;
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    audioAsVoice?: boolean;
    gifPlayback?: boolean;
    forceDocument?: boolean;
  };

/** Rich reply payload send context used when adapters can consume structured payloads. */
export type ChannelMessageSendPayloadContext<TConfig = OpenClawConfig> =
  ChannelMessageSendTextContext<TConfig> & {
    payload: ReplyPayload;
    mediaUrl?: string;
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    audioAsVoice?: boolean;
    gifPlayback?: boolean;
    forceDocument?: boolean;
  };

/** Poll send context; thread ids stay string-like because poll APIs do not accept numeric ids. */
export type ChannelMessageSendPollContext<TConfig = OpenClawConfig> = Omit<
  ChannelMessageSendTextContext<TConfig>,
  "text" | "threadId"
> & {
  poll: PollInput;
  threadId?: string | null;
  isAnonymous?: boolean;
};

/** Adapter send result normalized to a receipt plus optional legacy message id. */
export type ChannelMessageSendResult = {
  receipt: MessageReceipt;
  messageId?: string;
};

/** Discriminator for lifecycle hooks around a concrete adapter send attempt. */
export type ChannelMessageSendAttemptKind = "text" | "media" | "payload" | "poll";

/** Concrete send shapes an adapter can reconcile after an unknown platform outcome. */
export const unknownSendReconciliationKinds = [
  "text",
  "media",
  "payload",
  "poll",
  "batch",
] as const;

type UnknownSendReconciliationKind = (typeof unknownSendReconciliationKinds)[number];

/** Send-attempt context tagged with the adapter method core is about to call. */
export type ChannelMessageSendAttemptContext<TConfig = OpenClawConfig> =
  | (ChannelMessageSendTextContext<TConfig> & { kind: "text" })
  | (ChannelMessageSendMediaContext<TConfig> & { kind: "media" })
  | (ChannelMessageSendPayloadContext<TConfig> & { kind: "payload" })
  | (ChannelMessageSendPollContext<TConfig> & { kind: "poll" });

/** Lifecycle context emitted after an adapter send succeeds but before commit finishes. */
type ChannelMessageSendSuccessContext<
  TConfig = OpenClawConfig,
  TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult,
> = ChannelMessageSendAttemptContext<TConfig> & {
  result: TSendResult;
  attemptToken?: unknown;
};

/** Lifecycle context emitted after an adapter send throws or rejects. */
type ChannelMessageSendFailureContext<TConfig = OpenClawConfig> =
  ChannelMessageSendAttemptContext<TConfig> & {
    error: unknown;
    attemptToken?: unknown;
  };

/** Lifecycle context emitted when a successful send is being durably committed. */
export type ChannelMessageSendCommitContext<
  TConfig = OpenClawConfig,
  TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult,
> = ChannelMessageSendSuccessContext<TConfig, TSendResult>;

/** Durable queue context used to reconcile a send whose platform state is unknown. */
export type ChannelMessageUnknownSendContext<TConfig = OpenClawConfig> = {
  cfg: TConfig;
  queueId: string;
  channel: string;
  to: string;
  accountId?: string | null;
  enqueuedAt: number;
  retryCount: number;
  platformSendStartedAt?: number;
  /** Canonical reply target persisted after hooks and before platform I/O. */
  effectiveReplyToId?: string | null;
  payloads: readonly ReplyPayload[];
  renderedBatchPlan?: RenderedMessageBatchPlan;
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  threadId?: string | number | null;
  silent?: boolean;
};

/** Adapter verdict for whether an unknown queued send reached the platform. */
export type ChannelMessageUnknownSendReconciliationResult =
  | {
      status: "sent";
      receipt: MessageReceipt;
      messageId?: string;
    }
  | {
      status: "not_sent";
    }
  | {
      status: "unresolved";
      error?: string;
      retryable?: boolean;
    };

/** Provider decision made before core persists or replays a deferred delivery. */
export type ChannelMessageDeferredDeliveryAdmissionResult =
  | { status: "allowed" }
  | { status: "permanent_rejection"; reason: string };

/** Minimal context available at deferred-delivery admission boundaries. */
export type ChannelMessageDeferredDeliveryAdmissionContext<TConfig = OpenClawConfig> = {
  cfg: TConfig;
  channel: string;
  to: string;
  accountId?: string | null;
  phase: "live" | "recovery";
};

/** Optional hooks around adapter send attempts, platform success/failure, and commit. */
export type ChannelMessageSendLifecycleAdapter<
  TConfig = OpenClawConfig,
  TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult,
> = {
  beforeSendAttempt?: (ctx: ChannelMessageSendAttemptContext<TConfig>) => unknown;
  afterSendSuccess?: (
    ctx: ChannelMessageSendSuccessContext<TConfig, TSendResult>,
  ) => Promise<void> | void;
  afterSendFailure?: (ctx: ChannelMessageSendFailureContext<TConfig>) => Promise<void> | void;
  afterCommit?: (
    ctx: ChannelMessageSendCommitContext<TConfig, TSendResult>,
  ) => Promise<void> | void;
};

/** Adapter methods a message channel can implement for outbound text/media/payload/poll sends. */
type ChannelMessageSendAdapter<
  TConfig = OpenClawConfig,
  TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult,
> = {
  text?: (ctx: ChannelMessageSendTextContext<TConfig>) => Promise<TSendResult>;
  media?: (ctx: ChannelMessageSendMediaContext<TConfig>) => Promise<TSendResult>;
  payload?: (ctx: ChannelMessageSendPayloadContext<TConfig>) => Promise<TSendResult>;
  poll?: (ctx: ChannelMessageSendPollContext<TConfig>) => Promise<TSendResult>;
  lifecycle?: ChannelMessageSendLifecycleAdapter<TConfig, TSendResult>;
};

/** Durable final-delivery extension for queue reconciliation and capability declaration. */
export type ChannelMessageDurableFinalAdapter = {
  capabilities?: DurableFinalDeliveryRequirementMap;
  /**
   * Synchronous provider admission before a durable intent is created or replayed.
   * Providers must not perform I/O from this hook.
   */
  admitDeferredDelivery?: (
    ctx: ChannelMessageDeferredDeliveryAdmissionContext,
  ) => ChannelMessageDeferredDeliveryAdmissionResult;
  /** Send shapes for which reconciliation can prove the complete durable intent. */
  reconcileUnknownSendKinds?: Partial<Record<UnknownSendReconciliationKind, boolean>>;
  reconcileUnknownSend?: (
    ctx: ChannelMessageUnknownSendContext,
  ) =>
    | Promise<ChannelMessageUnknownSendReconciliationResult | null>
    | ChannelMessageUnknownSendReconciliationResult
    | null;
};

/** Live-message feature key declared by adapters that support preview or streaming behavior. */
export type ChannelMessageLiveCapability =
  | "draftPreview"
  | "previewFinalization"
  | "progressUpdates"
  | "nativeStreaming"
  | "quietFinalization";

/** Canonical ordered list of live-message feature keys. */
export const channelMessageLiveCapabilities = [
  "draftPreview",
  "previewFinalization",
  "progressUpdates",
  "nativeStreaming",
  "quietFinalization",
] as const satisfies readonly ChannelMessageLiveCapability[];

/** Capability keys for turning a preview into a final platform message. */
export const livePreviewFinalizerCapabilities = [
  "finalEdit",
  "normalFallback",
  "discardPending",
  "previewReceipt",
  "retainOnAmbiguousFailure",
] as const;

/** Finalizer capability key understood by live-message adapters. */
export type LivePreviewFinalizerCapability = (typeof livePreviewFinalizerCapabilities)[number];

/** Capability map for preview finalization behavior. */
export type LivePreviewFinalizerCapabilityMap = Partial<
  Record<LivePreviewFinalizerCapability, boolean>
>;

/** Adapter shape for finalizing live previews. */
type ChannelMessageLiveFinalizerAdapterShape = {
  capabilities?: LivePreviewFinalizerCapabilityMap;
};

/** Adapter shape for live preview and streaming message features. */
export type ChannelMessageLiveAdapterShape = {
  capabilities?: Partial<Record<ChannelMessageLiveCapability, boolean>>;
  finalizer?: ChannelMessageLiveFinalizerAdapterShape;
};

/** Receive acknowledgement timing policy for durable inbound message records. */
export type ChannelMessageReceiveAckPolicy =
  | "after_receive_record"
  | "after_agent_dispatch"
  | "after_durable_send"
  | "manual";

/** Canonical ordered list of receive acknowledgement policies. */
export const channelMessageReceiveAckPolicies = [
  "after_receive_record",
  "after_agent_dispatch",
  "after_durable_send",
  "manual",
] as const satisfies readonly ChannelMessageReceiveAckPolicy[];

/** Adapter receive shape for default and supported inbound acknowledgement policies. */
export type ChannelMessageReceiveAdapterShape = {
  defaultAckPolicy?: ChannelMessageReceiveAckPolicy;
  supportedAckPolicies?: readonly ChannelMessageReceiveAckPolicy[];
};

/** Full message adapter shape composed from send, durable-final, live, and receive facets. */
export type ChannelMessageAdapterShape<
  TConfig = OpenClawConfig,
  TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult,
> = {
  id?: string;
  durableFinal?: ChannelMessageDurableFinalAdapter;
  send?: ChannelMessageSendAdapter<TConfig, TSendResult>;
  live?: ChannelMessageLiveAdapterShape;
  receive?: ChannelMessageReceiveAdapterShape;
};

/** Concrete message adapter type, preserving channel-specific adapter refinements. */
export type ChannelMessageAdapter<
  TAdapter extends ChannelMessageAdapterShape = ChannelMessageAdapterShape,
> = TAdapter;

/** Extra durable-final requirement map for caller-derived capability checks. */
type DurableFinalRequirementExtras = DurableFinalDeliveryRequirementMap;

/** Inputs used to derive durable final-delivery requirements for a planned send. */
export type DeriveDurableFinalDeliveryRequirementsParams = {
  payload: DurableFinalDeliveryPayloadShape;
  replyToId?: string | null;
  threadId?: string | number | null;
  silent?: boolean;
  messageSendingHooks?: boolean;
  payloadTransport?: boolean;
  batch?: boolean;
  reconcileUnknownSend?: boolean;
  afterSendSuccess?: boolean;
  afterCommit?: boolean;
  extraCapabilities?: DurableFinalRequirementExtras;
};

/** Stable intent record for a durable outbound message send. */
export type DurableMessageSendIntent<TPayload = unknown> = {
  id: string;
  channel: string;
  to: string;
  accountId?: string;
  durability: Exclude<MessageDurabilityPolicy, "disabled">;
  renderedBatch?: RenderedMessageBatch<TPayload>;
};
