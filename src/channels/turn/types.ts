import type { CommandTurnKind } from "../../auto-reply/command-turn-context.js";
import type {
  GetReplyOptions,
  TurnAdoptionLifecycle,
} from "../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { DispatchFromConfigResult } from "../../auto-reply/reply/dispatch-from-config.types.js";
import type { GetReplyFromConfig } from "../../auto-reply/reply/get-reply.types.js";
import type { HistoryEntry, HistoryMediaEntry } from "../../auto-reply/reply/history.types.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import type { ReplyDispatcherWithTypingOptions } from "../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type {
  FinalizedMsgContext,
  InboundSourceModality,
  MsgContext,
  SupplementalContextFacts,
} from "../../auto-reply/templating.js";
import type { GroupKeyResolution } from "../../config/sessions/types.js";
import type { DmScope } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  DeliverOutboundPayloadsParams,
  DurableFinalDeliveryRequirements,
  OutboundDeliveryQueuePolicy,
} from "../../infra/outbound/deliver.js";
import type { InboundEventKind } from "../inbound-event/kind.js";
import type { CreateChannelReplyPipelineParams } from "../message/reply-pipeline.js";
import type { MessageReceipt } from "../message/types.js";
import type { InboundLastRouteUpdate, RecordInboundSession } from "../session.types.js";
import type { ChannelBotLoopProtectionFacts } from "./bot-loop-protection.js";

export type { SupplementalContextFacts } from "../../auto-reply/templating.js";

/** Admission decision for an inbound channel event before agent dispatch. */
export type ChannelTurnAdmission =
  | { kind: "dispatch"; reason?: string }
  | { kind: "observeOnly"; reason: string }
  | { kind: "handled"; reason: string }
  | { kind: "drop"; reason: string; recordHistory?: boolean };

/** Coarse event classification used to decide whether an event can start an agent turn. */
export type ChannelEventClass = {
  kind: "message" | "command" | "interaction" | "reaction" | "lifecycle" | "unknown";
  canStartAgentTurn: boolean;
  requiresImmediateAck?: boolean;
};

/** Normalized inbound event text and raw payload after channel-specific ingestion. */
export type NormalizedTurnInput = {
  id: string;
  timestamp?: number;
  rawText: string;
  textForAgent?: string;
  textForCommands?: string;
  raw?: unknown;
};

/** Sender identity facts projected into channel access, routing, and prompt context. */
export type SenderFacts = {
  id?: string;
  name?: string;
  username?: string;
  tag?: string;
  roles?: string[];
  isBot?: boolean;
  isSelf?: boolean;
  displayLabel?: string;
};

/** Conversation identity and threading facts for a channel turn. */
export type ConversationFacts = {
  kind: "direct" | "group" | "channel";
  id: string;
  label?: string;
  spaceId?: string;
  parentId?: string;
  threadId?: string;
  nativeChannelId?: string;
  routePeer?: {
    kind: "direct" | "group" | "channel";
    id: string;
  };
};

/** Session routing facts derived before dispatch. */
export type RouteFacts = {
  agentId: string;
  dmScope?: DmScope;
  accountId?: string;
  routeSessionKey: string;
  dispatchSessionKey?: string;
  persistedSessionKey?: string;
  parentSessionKey?: string;
  modelParentSessionKey?: string;
  mainSessionKey?: string;
  createIfMissing?: boolean;
};

/** Reply target and source-delivery facts for a channel turn. */
export type ReplyPlanFacts = {
  to: string;
  originatingTo?: string;
  nativeChannelId?: string;
  replyTarget?: string;
  deliveryTarget?: string;
  replyToId?: string;
  replyToIdFull?: string;
  messageThreadId?: string | number;
  threadParentId?: string;
  sourceReplyDeliveryMode?: "thread" | "reply" | "channel" | "direct" | "none";
};

/** Message text/history facts passed into templating and dispatch. */
export type MessageFacts = {
  inboundEventKind?: InboundEventKind;
  body?: string;
  rawBody: string;
  bodyForAgent?: string;
  commandBody?: string;
  envelopeFrom?: string;
  senderLabel?: string;
  preview?: string;
  inboundHistory?: HistoryEntry[];
  sourceModality?: InboundSourceModality;
};

/** Parsed command facts for command-like channel turns. */
export type CommandFacts = {
  kind: CommandTurnKind;
  body?: string;
  name?: string;
  authorized?: boolean;
};

/** Inbound media facts supplied to the agent context. */
export type InboundMediaFacts = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: "image" | "video" | "audio" | "document" | "unknown";
  transcribed?: boolean;
  messageId?: string;
};

type MaybePromise<T> = T | Promise<T>;

/** Adapter preflight output assembled before turn resolution. */
export type PreflightFacts = {
  admission?: ChannelTurnAdmission;
  command?: CommandFacts;
  message?: Partial<MessageFacts>;
  media?:
    | readonly InboundMediaFacts[]
    | (() => MaybePromise<
        readonly InboundMediaFacts[] | readonly HistoryMediaEntry[] | null | undefined
      >);
  supplemental?: SupplementalContextFacts;
  history?: ChannelTurnDroppedHistoryOptions;
};

/** Delivery metadata for one reply payload dispatch. */
export type ChannelDeliveryInfo = {
  kind: ReplyDispatchKind;
};

/** Durable delivery queue intent recorded when a reply is deferred. */
export type ChannelDeliveryIntent = {
  id: string;
  kind: "outbound_queue";
  queuePolicy: OutboundDeliveryQueuePolicy;
};

/** Result returned after delivering one channel reply payload. */
export type ChannelDeliveryResult = {
  messageIds?: string[];
  receipt?: MessageReceipt;
  threadId?: string;
  replyToId?: string;
  visibleReplySent?: boolean;
  deliveryIntent?: ChannelDeliveryIntent;
};

/** Durable outbound delivery options available to channel turn delivery adapters. */
type ChannelTurnDurableDeliveryOptions = Pick<
  DeliverOutboundPayloadsParams,
  "deps" | "formatting" | "identity" | "mediaAccess" | "replyToMode" | "silent" | "threadId"
> & {
  to?: string | null;
  replyToId?: string | null;
  requiredCapabilities?: DurableFinalDeliveryRequirements;
};

/** Delivery adapter used by channel turns to send reply payloads. */
export type ChannelEventDeliveryAdapter = {
  preparePayload?: (
    payload: ReplyPayload,
    info: ChannelDeliveryInfo,
  ) => Promise<ReplyPayload> | ReplyPayload;
  deliver: (
    payload: ReplyPayload,
    info: ChannelDeliveryInfo,
  ) => Promise<ChannelDeliveryResult | void>;
  durable?:
    | false
    | ChannelTurnDurableDeliveryOptions
    | ((
        payload: ReplyPayload,
        info: ChannelDeliveryInfo,
      ) =>
        | false
        | ChannelTurnDurableDeliveryOptions
        | Promise<false | ChannelTurnDurableDeliveryOptions>);
  onDelivered?: (
    payload: ReplyPayload,
    info: ChannelDeliveryInfo,
    result: ChannelDeliveryResult | void,
  ) => Promise<void> | void;
  onError?: (err: unknown, info: { kind: string }) => void;
};

/** Options for recording inbound session route state around a turn. */
export type ChannelTurnRecordOptions = {
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
  updateLastRoute?: InboundLastRouteUpdate;
  onRecordError?: (err: unknown) => void;
  trackSessionMetaTask?: (task: Promise<unknown>) => void;
};

/** Options for finalizing visible conversation history after dispatch. */
export type ChannelTurnHistoryFinalizeOptions = {
  isGroup?: boolean;
  historyKey?: string;
  historyMap?: Map<string, HistoryEntry[]>;
  limit?: number;
};

/** Options for recording history when an inbound event is dropped before dispatch. */
export type ChannelTurnDroppedHistoryOptions = {
  key: string;
  limit: number;
  historyMap: Map<string, HistoryEntry[]>;
  recordOnDrop?: boolean;
  mediaLimit?: number;
  shouldRecord?: () => boolean;
};

/** Dispatcher options excluding delivery hooks owned by the channel turn adapter. */
type ChannelTurnDispatcherOptions = Omit<ReplyDispatcherWithTypingOptions, "deliver" | "onError">;

/** Reply pipeline options excluding cfg/agent/channel identity supplied by the turn. */
type ChannelTurnReplyPipelineOptions = Omit<
  CreateChannelReplyPipelineParams,
  "cfg" | "agentId" | "channel" | "accountId"
>;

/** Fully assembled channel turn ready to build the dispatch runner. */
export type AssembledChannelTurn = {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  agentId: string;
  routeSessionKey: string;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  recordInboundSession: RecordInboundSession;
  afterRecord?: () => void | Promise<void>;
  dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
  delivery: ChannelEventDeliveryAdapter;
  replyPipeline?: ChannelTurnReplyPipelineOptions;
  dispatcherOptions?: ChannelTurnDispatcherOptions;
  toolsAllow?: string[];
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
  sessionInitRetry?: {
    delaysMs: readonly number[];
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  };
  record?: ChannelTurnRecordOptions;
  history?: ChannelTurnHistoryFinalizeOptions;
  admission?: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
  botLoopProtection?: ChannelBotLoopProtectionFacts;
  log?: (event: ChannelTurnLogEvent) => void;
  messageId?: string;
  /** Canonical adoption lifecycle threaded into replyOptions. */
  turnAdoptionLifecycle?: TurnAdoptionLifecycle;
};

type PreparedChannelTurnDispatchSkipReason = "botLoopProtection" | "observeOnly";

/** Lifecycle ownership declared alongside an already-prepared dispatch runner. */
type PreparedChannelTurnDispatchLifecycle = {
  /** Exact adoption lifecycle captured by runDispatch, or undefined for non-durable turns. */
  turnAdoptionLifecycle: TurnAdoptionLifecycle | undefined;
  /** Releases resources that runDispatch would otherwise settle when dispatch is skipped. */
  onDispatchSkipped: (reason: PreparedChannelTurnDispatchSkipReason) => void | Promise<void>;
};

/** Channel turn with dispatch runner already prepared. */
export type PreparedChannelTurn<TDispatchResult = DispatchFromConfigResult> = {
  channel: string;
  accountId?: string;
  routeSessionKey: string;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  recordInboundSession: RecordInboundSession;
  afterRecord?: () => void | Promise<void>;
  record?: ChannelTurnRecordOptions;
  history?: ChannelTurnHistoryFinalizeOptions;
  onPreDispatchFailure?: (err: unknown) => void | Promise<void>;
  runDispatch: () => Promise<TDispatchResult>;
  /** Optional for the legacy direct prepared runner; inbound adapters use the stricter type. */
  runDispatchLifecycle?: PreparedChannelTurnDispatchLifecycle;
  observeOnlyDispatchResult?: TDispatchResult;
  admission?: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
  botLoopProtection?: ChannelBotLoopProtectionFacts;
  log?: (event: ChannelTurnLogEvent) => void;
  messageId?: string;
};

type ChannelTurnRoute = {
  agentId: string;
  dmScope?: DmScope;
  sessionKey: string;
};

type RoutedChannelTurn<T> = Omit<T, "routeSessionKey" | "storePath" | "recordInboundSession"> & {
  route: ChannelTurnRoute;
};

type InboundPreparedChannelTurn<TDispatchResult = DispatchFromConfigResult> =
  PreparedChannelTurn<TDispatchResult> & {
    runDispatchLifecycle: PreparedChannelTurnDispatchLifecycle;
  };

export type ChannelTurnPlan = RoutedChannelTurn<
  Omit<AssembledChannelTurn, "agentId" | "dispatchReplyWithBufferedBlockDispatcher">
>;

type PreparedChannelTurnPlan<TDispatchResult = DispatchFromConfigResult> = RoutedChannelTurn<
  InboundPreparedChannelTurn<TDispatchResult>
> & {
  cfg: OpenClawConfig;
};

/** Resolved turn shape returned by adapters before final run/dispatch handling. */
export type ChannelTurnResolved<TDispatchResult = DispatchFromConfigResult> =
  | ChannelTurnPlan
  | PreparedChannelTurnPlan<TDispatchResult>
  | (AssembledChannelTurn & {
      admission?: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
    })
  | (InboundPreparedChannelTurn<TDispatchResult> & {
      admission?: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
    });

/** Ordered lifecycle stage names emitted to channel turn log hooks. */
type ChannelTurnStage =
  | "ingest"
  | "classify"
  | "preflight"
  | "resolve"
  | "authorize"
  | "assemble"
  | "record"
  | "dispatch"
  | "finalize";

/** Structured channel turn log event. */
export type ChannelTurnLogEvent = {
  stage: ChannelTurnStage;
  event: "start" | "done" | "drop" | "handled" | "error" | "warning";
  channel: string;
  accountId?: string;
  messageId?: string;
  sessionKey?: string;
  admission?: ChannelTurnAdmission["kind"];
  reason?: string;
  error?: unknown;
};

/** Final result for a channel turn, dispatched or admitted without dispatch. */
export type ChannelTurnResult<TDispatchResult = DispatchFromConfigResult> =
  | DispatchedChannelTurnResult<TDispatchResult>
  | {
      admission: ChannelTurnAdmission;
      dispatched: false;
      ctxPayload?: MsgContext;
      routeSessionKey?: string;
    };

/** Successful dispatch result for a channel turn. */
export type DispatchedChannelTurnResult<TDispatchResult = DispatchFromConfigResult> = {
  admission: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
  dispatched: true;
  ctxPayload: MsgContext;
  routeSessionKey: string;
  dispatchResult: TDispatchResult;
};

/** Adapter contract for ingesting, classifying, resolving, and finalizing raw channel events. */
type ChannelTurnAdapter<TRaw, TDispatchResult = DispatchFromConfigResult> = {
  ingest: (raw: TRaw) => Promise<NormalizedTurnInput | null> | NormalizedTurnInput | null;
  classify?: (input: NormalizedTurnInput) => Promise<ChannelEventClass> | ChannelEventClass;
  preflight?: (
    input: NormalizedTurnInput,
    eventClass: ChannelEventClass,
  ) =>
    | Promise<PreflightFacts | ChannelTurnAdmission | null | undefined>
    | PreflightFacts
    | ChannelTurnAdmission
    | null
    | undefined;
  resolveTurn: (
    input: NormalizedTurnInput,
    eventClass: ChannelEventClass,
    preflight: PreflightFacts,
  ) => Promise<ChannelTurnResolved<TDispatchResult>> | ChannelTurnResolved<TDispatchResult>;
  onFinalize?: (result: ChannelTurnResult<TDispatchResult>) => Promise<void> | void;
};

/** Parameters for running one raw channel event through the turn kernel. */
export type RunChannelTurnParams<TRaw, TDispatchResult = DispatchFromConfigResult> = {
  channel: string;
  accountId?: string;
  raw: TRaw;
  adapter: ChannelTurnAdapter<TRaw, TDispatchResult>;
  log?: (event: ChannelTurnLogEvent) => void;
  /** Canonical adoption lifecycle for this turn. */
  turnAdoptionLifecycle?: TurnAdoptionLifecycle;
};
