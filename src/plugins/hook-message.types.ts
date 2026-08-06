import type { MessageHookMediaFact } from "../hooks/message-hook-media.js";
import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import type { PluginConversationBinding } from "./conversation-binding.types.js";

/** Ordered media fact exposed by inbound message hooks. */
export type PluginHookMediaFact = MessageHookMediaFact;

/** Provider metadata plus deprecated media aliases retained during the SDK migration window. */
export type PluginHookInboundMessageMetadata = Record<string, unknown> & {
  /** @deprecated Use the first `event.media` fact with a defined `path`. */
  mediaPath?: string;
  /** @deprecated Use the first `event.media` fact's `url ?? path`. */
  mediaUrl?: string;
  /** @deprecated Use the first `event.media` fact's `contentType ?? kind`. */
  mediaType?: string;
  /** @deprecated Collect defined `path` values from `event.media` in order. */
  mediaPaths?: string[];
  /** @deprecated Collect each defined `url ?? path` from `event.media` in order. */
  mediaUrls?: string[];
  /** @deprecated Collect each defined `contentType ?? kind` from `event.media` in order. */
  mediaTypes?: string[];
  /** @deprecated Use the first `event.originalMedia` fact with a defined `path`. */
  originalMediaPath?: string;
  /** @deprecated Use the first `event.originalMedia` fact's `url ?? path`. */
  originalMediaUrl?: string;
  /** @deprecated Use the first `event.originalMedia` fact's `contentType ?? kind`. */
  originalMediaType?: string;
  /** @deprecated Collect defined `path` values from `event.originalMedia` in order. */
  originalMediaPaths?: string[];
  /** @deprecated Collect each defined `url ?? path` from `event.originalMedia` in order. */
  originalMediaUrls?: string[];
  /** @deprecated Collect each defined `contentType ?? kind` from `event.originalMedia` in order. */
  originalMediaTypes?: string[];
  /** @deprecated Use `event.mediaStagingPending`. */
  mediaStagingPending?: boolean;
};

export type PluginHookMessageContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  /**
   * Canonical session key for this conversation — the same value the agent
   * runtime sees as `params.sessionKey` for the run that produced the
   * outbound payload, and the same value `agent_end`/`llm_input`/`llm_output`
   * fire with. Plugins correlating per-turn state across `agent_end` and
   * `message_sending` rely on this equality.
   *
   * For inbound message hooks (`inbound_claim` etc.), this is the canonical
   * session for the inbound conversation as resolved by `resolveSessionKey`
   * / `deriveInboundMessageHookContext`.
   *
   * For outbound delivery hooks (`message_sending` and `message_sent`),
   * this mirrors `OutboundSessionContext.key` from the dispatch path when
   * delivery has a session attached. When the outbound path has no
   * resolvable session (e.g. internal smoke runs without
   * `OutboundSessionContext`), this field is omitted; plugins must treat
   * it as optional.
   */
  sessionKey?: string;
  /**
   * Per-turn run identifier (UUID), unique to one end-to-end agent turn:
   * stable across all LLM-call iterations, retry attempts (compaction,
   * empty-response, planning-only, etc.), and multi-payload reply chunks
   * within that turn; distinct for each new inbound user message and for
   * each cron/heartbeat/followup-triggered run.
   *
   * Generated once in `agent-runner-execution.ts`/`followup-runner.ts` via
   * `crypto.randomUUID()`. Currently populated for inbound message hooks
   * (`inbound_claim`, `message_received`) and for agent-runtime hooks that
   * already receive the run id (e.g. `agent_end`, `llm_input`, `llm_output`).
   * It is **not yet** plumbed through the outbound delivery path, so
   * plugins observing `message_sending` / `message_sent` should not rely
   * on `runId` to correlate against `agent_end`; use `sessionKey` for
   * outbound→inbound correlation today (with the caveat that it cannot
   * disambiguate concurrent turns in the same session).
   */
  runId?: string;
  messageId?: string;
  senderId?: string;
  replyToId?: string;
  replyToIdFull?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote?: boolean;
  trace?: DiagnosticTraceContext;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  callDepth?: number;
};

export type PluginHookInboundClaimContext = PluginHookMessageContext & {
  /** Resolved owner for session scopes whose canonical key does not encode an agent id. */
  agentId?: string;
  parentConversationId?: string;
  senderId?: string;
  messageId?: string;
  pluginBinding?: PluginConversationBinding;
};

export type PluginHookInboundClaimEvent = {
  content: string;
  body?: string;
  bodyForAgent?: string;
  transcript?: string;
  timestamp?: number;
  channel: string;
  accountId?: string;
  conversationId?: string;
  parentConversationId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  replyToId?: string;
  replyToIdFull?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote?: boolean;
  threadId?: string | number;
  messageId?: string;
  sessionKey?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  isGroup: boolean;
  commandAuthorized?: boolean;
  senderIsOwner?: boolean;
  wasMentioned?: boolean;
  /** Staged, locally usable attachments in stable source order. */
  media?: PluginHookMediaFact[];
  /** Original attachment facts when local staging has not completed yet. */
  originalMedia?: PluginHookMediaFact[];
  /** True when `originalMedia` is present but `media` is intentionally withheld pending staging. */
  mediaStagingPending?: boolean;
  metadata?: PluginHookInboundMessageMetadata;
};

export type PluginHookMessageReceivedEvent = {
  from: string;
  content: string;
  timestamp?: number;
  threadId?: string | number;
  messageId?: string;
  senderId?: string;
  replyToId?: string;
  replyToIdFull?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote?: boolean;
  sessionKey?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  /** Staged, locally usable attachments in stable source order. */
  media?: PluginHookMediaFact[];
  /** Original attachment facts when local staging has not completed yet. */
  originalMedia?: PluginHookMediaFact[];
  /** True when `originalMedia` is present but `media` is intentionally withheld pending staging. */
  mediaStagingPending?: boolean;
  metadata?: PluginHookInboundMessageMetadata;
};

export type PluginHookMessageSendingEvent = {
  to: string;
  content: string;
  replyToId?: string | number;
  threadId?: string | number;
  metadata?: Record<string, unknown>;
};

export type PluginHookMessageSendingResult = {
  content?: string;
  cancel?: boolean;
  cancelReason?: string;
  metadata?: Record<string, unknown>;
};

export type PluginHookMessageSentEvent = {
  to: string;
  content: string;
  success: boolean;
  messageId?: string;
  sessionKey?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  error?: string;
};
