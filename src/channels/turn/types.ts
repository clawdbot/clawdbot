// Type contracts for channel turn normalization, admission, dispatch, and delivery.
import type { CommandTurnKind } from "../../auto-reply/command-turn-context.js";
import type { GetReplyOptions } from "../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { DispatchFromConfigResult } from "../../auto-reply/reply/dispatch-from-config.types.js";
import type { GetReplyFromConfig } from "../../auto-reply/reply/get-reply.types.js";
import type { HistoryEntry, HistoryMediaEntry } from "../../auto-reply/reply/history.types.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import type { ReplyDispatcherWithTypingOptions } from "../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext, MsgContext } from "../../auto-reply/templating.js";
import type { GroupKeyResolution } from "../../config/sessions/types.js";
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

export type { InboundEventKind } from "../inbound-event/kind.js";

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

/** Allowlist projection used by access checks without exposing raw configured entries. */
export type ProjectedAllowlistAccessFacts = {
  configured: boolean;
  matched: boolean;
  reasonCode?: string;
  matchedEntryIds: string[];
  invalidEntryCount: number;
  disabledEntryCount: number;
  accessGroups: {
    referenced: string[];
    matched: string[];
    missing: string[];
    unsupported: string[];
    failed: string[];
  };
};

/** Event-level access projection for commands, reactions, buttons, and native events. */
export type ProjectedEventAccessFacts = {
  kind:
    | "message"
    | "reaction"
    | "button"
    | "postback"
    | "native-command"
    | "slash-command"
    | "system";
  authMode: "inbound" | "command" | "origin-subject" | "route-only" | "none";
  mayPair: boolean;
  authorized: boolean;
  reasonCode?: string;
  hasOriginSubject: boolean;
  originSubjectMatched: boolean;
};

/** Access decisions for DMs, groups, commands, events, and mention gating. */
export type AccessFacts = {
  dm?: {
    decision: "allow" | "pairing" | "deny";
    reason?: string;
    /**
     * @deprecated Shared ingress projections redact allowlist entries and return an empty compat list.
     * Use allowlist diagnostics instead.
     */
    allowFrom: string[];
    allowlist?: ProjectedAllowlistAccessFacts;
  };
  group?: {
    policy: "open" | "allowlist" | "disabled";
    routeAllowed: boolean;
    senderAllowed: boolean;
    /**
     * @deprecated Shared ingress projections redact allowlist entries and return an empty compat list.
     * Use allowlist diagnostics instead.
     */
    allowFrom: string[];
    requireMention: boolean;
    allowlist?: ProjectedAllowlistAccessFacts;
  };
  commands?: {
    authorized?: boolean;
    shouldBlockControlCommand?: boolean;
    reasonCode?: string;
    useAccessGroups: boolean;
    allowTextCommands: boolean;
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
    /**
     * @deprecated Shared ingress projections do not expose raw authorizer lists.
     * Use authorized and reasonCode instead.
     */
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  };
  event?: ProjectedEventAccessFacts;
  mentions?: {
    canDetectMention: boolean;
    wasMentioned: boolean;
    hasAnyMention?: boolean;
    implicitMentionKinds?: Array<
      "reply_to_bot" | "quoted_bot" | "bot_thread_participant" | "native"
    >;
    requireMention?: boolean;
    effectiveWasMentioned?: boolean;
    shouldSkip?: boolean;
  };
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
};

/** Parsed command facts for command-like channel turns. */
export type CommandFacts = {
  kind: CommandTurnKind;
  body?: string;
  name?: string;
  authorized?: boolean;
};

/** Quoted, forwarded, thread, and untrusted context facts attached to an inbound turn. */
export type SupplementalContextFacts = {
  quote?: {
    id?: string;
    fullId?: string;
    body?: string;
    sender?: string;
    senderAllowed?: boolean;
    isExternal?: boolean;
    isQuote?: boolean;
  };
  forwarded?: {
    from?: string;
    fromType?: string;
    fromId?: string;
    date?: number;
    senderAllowed?: boolean;
  };
  thread?: {
    id?: string;
    starterBody?: string;
    historyBody?: string;
    label?: string;
    parentSessionKey?: string;
    modelParentSessionKey?: string;
    senderAllowed?: boolean;
  };
  untrustedContext?: Array<{ label: string; source?: string; type?: string; payload: unknown }>;
  groupSystemPrompt?: string;
  /** Prompt-like group metadata from user-controlled sources; never enters the system prompt. */
  untrustedGroupSystemPrompt?: string;
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
export type ChannelTurnDurableDeliveryOptions = Pick<
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
export type ChannelTurnDispatcherOptions = Omit<
  ReplyDispatcherWithTypingOptions,
  "deliver" | "onError"
>;

/** Reply pipeline options excluding cfg/agent/channel identity supplied by the turn. */
export type ChannelTurnReplyPipelineOptions = Omit<
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
  dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
  delivery: ChannelEventDeliveryAdapter;
  replyPipeline?: ChannelTurnReplyPipelineOptions;
  dispatcherOptions?: ChannelTurnDispatcherOptions;
  toolsAllow?: string[];
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
  record?: ChannelTurnRecordOptions;
  history?: ChannelTurnHistoryFinalizeOptions;
  admission?: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
  botLoopProtection?: ChannelBotLoopProtectionFacts;
  log?: (event: ChannelTurnLogEvent) => void;
  messageId?: string;
};

/** Channel turn with dispatch runner already prepared. */
export type PreparedChannelTurn<TDispatchResult = DispatchFromConfigResult> = {
  channel: string;
  accountId?: string;
  routeSessionKey: string;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  recordInboundSession: RecordInboundSession;
  record?: ChannelTurnRecordOptions;
  history?: ChannelTurnHistoryFinalizeOptions;
  onPreDispatchFailure?: (err: unknown) => void | Promise<void>;
  runDispatch: () => Promise<TDispatchResult>;
  observeOnlyDispatchResult?: TDispatchResult;
  admission?: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
  botLoopProtection?: ChannelBotLoopProtectionFacts;
  log?: (event: ChannelTurnLogEvent) => void;
  messageId?: string;
};

/** Resolved turn shape returned by adapters before final run/dispatch handling. */
export type ChannelTurnResolved<TDispatchResult = DispatchFromConfigResult> =
  | (AssembledChannelTurn & {
      admission?: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
    })
  | (PreparedChannelTurn<TDispatchResult> & {
      admission?: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
    });

/** Ordered lifecycle stage names emitted to channel turn log hooks. */
export type ChannelTurnStage =
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
  event: "start" | "done" | "drop" | "handled" | "error";
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
export type ChannelTurnAdapter<TRaw, TDispatchResult = DispatchFromConfigResult> = {
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
};
