// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { InputProvenanceSchema, NonEmptyString, SessionLabelString } from "./primitives.js";

/**
 * Agent and channel-action gateway schemas.
 *
 * These payloads sit on the boundary between external channel adapters, gateway
 * RPC callers, and the agent runtime. Keep public request fields documented
 * because older CLI/channel clients may continue sending them across releases.
 */
const AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION = "task_completion";
const AGENT_INTERNAL_EVENT_SOURCES = [
  "subagent",
  "cron",
  "image_generation",
  "video_generation",
  "music_generation",
] as const;
const AGENT_INTERNAL_EVENT_STATUSES = ["ok", "timeout", "error", "unknown"] as const;
const CONVERSATION_REF_PATTERN = "^conv_[a-f0-9]{32}$";

/** Generated media/file attachment metadata carried by internal agent events. */
const AgentGeneratedAttachmentSchema = closedObject({
  type: Type.Optional(Type.String({ enum: ["image", "audio", "video", "file"] })),
  path: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  mediaUrl: Type.Optional(Type.String()),
  filePath: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
});

/** Internal completion event surfaced when child automation reports back to a parent run. */
const AgentInternalEventSchema = closedObject({
  type: Type.Literal(AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION),
  source: Type.String({ enum: [...AGENT_INTERNAL_EVENT_SOURCES] }),
  childSessionKey: Type.String(),
  childSessionId: Type.Optional(Type.String()),
  announceType: Type.String(),
  taskLabel: Type.String(),
  status: Type.String({ enum: [...AGENT_INTERNAL_EVENT_STATUSES] }),
  statusLabel: Type.String(),
  result: Type.String(),
  attachments: Type.Optional(Type.Array(AgentGeneratedAttachmentSchema)),
  mediaUrls: Type.Optional(Type.Array(Type.String())),
  statsLine: Type.Optional(Type.String()),
  replyInstruction: Type.String(),
});

/** Stream event emitted by the agent runtime over the gateway protocol. */
export const AgentEventSchema = closedObject({
  runId: NonEmptyString,
  seq: Type.Integer({ minimum: 0 }),
  stream: NonEmptyString,
  ts: Type.Integer({ minimum: 0 }),
  spawnedBy: Type.Optional(NonEmptyString),
  isHeartbeat: Type.Optional(Type.Boolean()),
  data: Type.Record(Type.String(), Type.Unknown()),
});

/** Caller-supplied routing hints. Authorization must use trusted runtime context. */
const MessageActionToolContextSchema = closedObject({
  currentChannelId: Type.Optional(Type.String()),
  currentMessagingTarget: Type.Optional(Type.String()),
  currentGraphChannelId: Type.Optional(Type.String()),
  currentChannelProvider: Type.Optional(Type.String()),
  currentThreadTs: Type.Optional(Type.String()),
  currentMessageId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  replyToMode: Type.Optional(
    Type.Union([
      Type.Literal("off"),
      Type.Literal("first"),
      Type.Literal("all"),
      Type.Literal("batched"),
    ]),
  ),
  hasRepliedRef: Type.Optional(
    closedObject({
      value: Type.Boolean(),
    }),
  ),
  sameChannelThreadRequired: Type.Optional(Type.Boolean()),
  skipCrossContextDecoration: Type.Optional(Type.Boolean()),
});

/** Request to execute a channel message action through a configured adapter. */
export const MessageActionParamsSchema = closedObject({
  channel: NonEmptyString,
  action: NonEmptyString,
  params: Type.Record(Type.String(), Type.Unknown()),
  accountId: Type.Optional(Type.String()),
  requesterAccountId: Type.Optional(Type.String()),
  requesterSenderId: Type.Optional(Type.String()),
  // Honored only when the RPC caller has the full operator scope set
  // (shared-secret bearer or `operator.admin`). For narrowly-scoped
  // callers (e.g. `operator.write`-only) the gateway forces this to
  // `false` regardless of the value sent here.
  senderIsOwner: Type.Optional(Type.Boolean()),
  sessionKey: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  inboundTurnKind: Type.Optional(Type.String({ enum: ["user_request", "room_event"] })),
  agentId: Type.Optional(Type.String()),
  toolContext: Type.Optional(MessageActionToolContextSchema),
  /**
   * Explicit operation-local marker for an authenticated direct operator.
   * Missing values remain delegated, and agent runtime identity wins server-side.
   */
  conversationReadOrigin: Type.Optional(Type.Literal("direct-operator")),
  idempotencyKey: NonEmptyString,
});

/** Outbound send request shared by channel adapters. */
export const SendParamsSchema = closedObject({
  to: NonEmptyString,
  message: Type.Optional(Type.String()),
  mediaUrl: Type.Optional(Type.String()),
  mediaUrls: Type.Optional(Type.Array(Type.String())),
  /** Base64 attachment payload for gateway-local media materialization. */
  buffer: Type.Optional(Type.String()),
  /** Optional filename for a base64 attachment payload. */
  filename: Type.Optional(Type.String()),
  /** Optional MIME type for a base64 attachment payload. */
  contentType: Type.Optional(Type.String()),
  asVoice: Type.Optional(Type.Boolean()),
  gifPlayback: Type.Optional(Type.Boolean()),
  channel: Type.Optional(Type.String()),
  accountId: Type.Optional(Type.String()),
  /** Optional agent id for per-agent media root resolution on gateway sends. */
  agentId: Type.Optional(Type.String()),
  /** Reply target message id for native quoted/threaded sends where supported. */
  replyToId: Type.Optional(Type.String()),
  /** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
  threadId: Type.Optional(Type.String()),
  /** Force document-style media sends where supported. */
  forceDocument: Type.Optional(Type.Boolean()),
  /** Send silently (no notification) where supported. */
  silent: Type.Optional(Type.Boolean()),
  /** Channel-specific parse mode for formatted text. */
  parseMode: Type.Optional(Type.Literal("HTML")),
  /** Optional session key for mirroring delivered output back into the transcript. */
  sessionKey: Type.Optional(Type.String()),
  idempotencyKey: NonEmptyString,
});

/** Gateway-owned request that lists persisted and channel-directory addresses. */
export const ConversationListParamsSchema = closedObject({
  agentId: NonEmptyString,
  channel: Type.Optional(NonEmptyString),
  query: Type.Optional(NonEmptyString),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const ConversationListItemSchema = closedObject({
  conversationRef: Type.String({ pattern: CONVERSATION_REF_PATTERN }),
  channel: NonEmptyString,
  accountId: NonEmptyString,
  kind: Type.Union([Type.Literal("direct"), Type.Literal("group"), Type.Literal("channel")]),
  target: NonEmptyString,
  threadId: Type.Optional(NonEmptyString),
  label: Type.Optional(NonEmptyString),
  firstSeenAt: Type.Integer({ minimum: 0 }),
  lastSeenAt: Type.Integer({ minimum: 0 }),
});

export const ConversationListResultSchema = closedObject({
  conversations: Type.Array(ConversationListItemSchema),
});

/** Gateway-owned request that sends to one durable external conversation. */
export const ConversationSendParamsSchema = closedObject({
  agentId: NonEmptyString,
  sourceSessionKey: Type.Optional(NonEmptyString),
  operationId: NonEmptyString,
  conversationRef: Type.String({ pattern: CONVERSATION_REF_PATTERN }),
  message: NonEmptyString,
});

export const ConversationSendResultSchema = closedObject({
  status: Type.Union([
    Type.Literal("sent"),
    Type.Literal("queued"),
    Type.Literal("suppressed"),
    Type.Literal("unknown"),
  ]),
  conversationRef: Type.String({ pattern: CONVERSATION_REF_PATTERN }),
  channel: NonEmptyString,
  messageId: Type.Optional(NonEmptyString),
  queueId: Type.Optional(NonEmptyString),
});

/** Gateway-owned request that sends and consumes one correlated external reply inline. */
export const ConversationTurnParamsSchema = closedObject({
  agentId: NonEmptyString,
  sourceSessionKey: Type.Optional(NonEmptyString),
  turnId: NonEmptyString,
  conversationRef: Type.String({ pattern: CONVERSATION_REF_PATTERN }),
  message: NonEmptyString,
  timeoutMs: Type.Integer({ minimum: 1, maximum: 300_000 }),
});

export const ConversationTurnCancelParamsSchema = closedObject({
  agentId: NonEmptyString,
  turnId: NonEmptyString,
});

export const ConversationTurnCancelResultSchema = closedObject({
  cancelled: Type.Boolean(),
});

export const ConversationTurnReplySchema = closedObject({
  conversationRef: Type.String({ pattern: CONVERSATION_REF_PATTERN }),
  messageId: NonEmptyString,
  replyToId: Type.Optional(NonEmptyString),
  threadId: Type.Optional(NonEmptyString),
  text: Type.String(),
  timestamp: Type.Integer({ minimum: 0 }),
  transcriptArtifactId: Type.Optional(NonEmptyString),
  transcriptMessageId: Type.Optional(NonEmptyString),
});

const ConversationTurnBaseResultSchema = {
  conversationRef: Type.String({ pattern: CONVERSATION_REF_PATTERN }),
  channel: NonEmptyString,
  messageId: NonEmptyString,
  correlationPersisted: Type.Boolean(),
};

export const ConversationTurnResultSchema = Type.Union([
  closedObject({
    ...ConversationTurnBaseResultSchema,
    status: Type.Literal("replied"),
    reply: ConversationTurnReplySchema,
  }),
  closedObject({
    ...ConversationTurnBaseResultSchema,
    status: Type.Literal("timeout"),
  }),
  closedObject({
    conversationRef: Type.String({ pattern: CONVERSATION_REF_PATTERN }),
    channel: NonEmptyString,
    messageId: Type.Optional(NonEmptyString),
    correlationPersisted: Type.Boolean(),
    status: Type.Union([
      Type.Literal("sent"),
      Type.Literal("queued"),
      Type.Literal("suppressed"),
      Type.Literal("unknown"),
    ]),
    error: NonEmptyString,
  }),
]);

/** Poll creation request for adapters that support native polls. */
export const PollParamsSchema = closedObject({
  to: NonEmptyString,
  question: NonEmptyString,
  options: Type.Array(NonEmptyString, { minItems: 2, maxItems: 12 }),
  maxSelections: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
  /** Poll duration in seconds (channel-specific limits may apply). */
  durationSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 604_800 })),
  durationHours: Type.Optional(Type.Integer({ minimum: 1 })),
  /** Send silently (no notification) where supported. */
  silent: Type.Optional(Type.Boolean()),
  /** Poll anonymity where supported (e.g. Telegram polls default to anonymous). */
  isAnonymous: Type.Optional(Type.Boolean()),
  /** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
  threadId: Type.Optional(Type.String()),
  channel: Type.Optional(Type.String()),
  accountId: Type.Optional(Type.String()),
  idempotencyKey: NonEmptyString,
});

/** Main agent-run request accepted by the gateway. */
export const AgentParamsSchema = closedObject({
  message: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  replyTo: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  sessionKey: Type.Optional(Type.String()),
  // Backend-owned continuations can bind work to an already-admitted transcript.
  expectedExistingSessionId: Type.Optional(NonEmptyString),
  thinking: Type.Optional(Type.String()),
  deliver: Type.Optional(Type.Boolean()),
  attachments: Type.Optional(Type.Array(Type.Unknown())),
  channel: Type.Optional(Type.String()),
  replyChannel: Type.Optional(Type.String()),
  accountId: Type.Optional(Type.String()),
  replyAccountId: Type.Optional(Type.String()),
  threadId: Type.Optional(Type.String()),
  groupId: Type.Optional(Type.String()),
  groupChannel: Type.Optional(Type.String()),
  groupSpace: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Integer({ minimum: 0 })),
  bestEffortDeliver: Type.Optional(Type.Boolean()),
  lane: Type.Optional(Type.String()),
  cwd: Type.Optional(NonEmptyString),
  // One-shot CLI gateway requests can ask the gateway to close process-wide
  // bundle MCP resources after the run instead of keeping them warm.
  cleanupBundleMcpOnRunEnd: Type.Optional(Type.Boolean()),
  modelRun: Type.Optional(Type.Boolean()),
  promptMode: Type.Optional(
    Type.Union([Type.Literal("full"), Type.Literal("minimal"), Type.Literal("none")]),
  ),
  extraSystemPrompt: Type.Optional(Type.String()),
  bootstrapContextMode: Type.Optional(
    Type.Union([Type.Literal("full"), Type.Literal("lightweight")]),
  ),
  // Commitment fan-out scope is scheduler-internal and cannot be selected over Gateway RPC.
  bootstrapContextRunKind: Type.Optional(
    Type.Union([Type.Literal("default"), Type.Literal("heartbeat"), Type.Literal("cron")]),
  ),
  acpTurnSource: Type.Optional(Type.Literal("manual_spawn")),
  internalRuntimeHandoffId: Type.Optional(NonEmptyString),
  execApprovalFollowupExpectedSessionId: Type.Optional(NonEmptyString),
  internalEvents: Type.Optional(Type.Array(AgentInternalEventSchema)),
  inputProvenance: Type.Optional(InputProvenanceSchema),
  suppressPromptPersistence: Type.Optional(Type.Boolean()),
  sessionEffects: Type.Optional(Type.Union([Type.Literal("visible"), Type.Literal("internal")])),
  sourceReplyDeliveryMode: Type.Optional(
    Type.Union([Type.Literal("automatic"), Type.Literal("message_tool_only")]),
  ),
  disableMessageTool: Type.Optional(Type.Boolean()),
  swarmCollector: Type.Optional(Type.Boolean()),
  swarmOutputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  // Host-owned recovery turns can force every Code Mode exec onto the
  // restart-safe path even if the model omits or clears the tool argument.
  forceRestartSafeTools: Type.Optional(Type.Boolean()),
  voiceWakeTrigger: Type.Optional(Type.String()),
  // Recovery callers may read only an existing idempotency entry. A cache miss
  // must fail instead of admitting a new run with the same request payload.
  replayOnly: Type.Optional(Type.Boolean()),
  // Per-request random capability required for cache-only replay.
  replayCapability: Type.Optional(NonEmptyString),
  idempotencyKey: NonEmptyString,
  label: Type.Optional(SessionLabelString),
});

/** Identity lookup request for the current or selected agent/session. */
export const AgentIdentityParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(Type.String()),
});

/** Public display identity returned for an agent. */
export const AgentIdentityResultSchema = closedObject({
  agentId: NonEmptyString,
  name: Type.Optional(NonEmptyString),
  avatar: Type.Optional(NonEmptyString),
  avatarSource: Type.Optional(NonEmptyString),
  avatarStatus: Type.Optional(Type.String({ enum: ["none", "local", "remote", "data"] })),
  avatarReason: Type.Optional(NonEmptyString),
  emoji: Type.Optional(NonEmptyString),
});

/** Waits for a submitted agent run to complete or time out. */
export const AgentWaitParamsSchema = closedObject({
  runId: NonEmptyString,
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

/** Wake request from external schedulers or devices into an agent session. */
export const WakeParamsSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")]),
    text: NonEmptyString,
    // Typed field; misspelled variants remain opaque metadata because wake
    // senders already rely on additionalProperties.
    sessionKey: Type.Optional(NonEmptyString),
    /**
     * Optional agent id paired with `sessionKey`. Routes multi-agent setups
     * to the agent that owns the targeted session — closes the related half
     * of #46886 ("always routes to default agent").
     */
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: true }, // external wake senders may attach opaque metadata
);

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type AgentEvent = Static<typeof AgentEventSchema>;
export type AgentIdentityParams = Static<typeof AgentIdentityParamsSchema>;
export type AgentIdentityResult = Static<typeof AgentIdentityResultSchema>;
export type ConversationListParams = Static<typeof ConversationListParamsSchema>;
export type ConversationListItem = Static<typeof ConversationListItemSchema>;
export type ConversationListResult = Static<typeof ConversationListResultSchema>;
export type ConversationSendParams = Static<typeof ConversationSendParamsSchema>;
export type ConversationSendResult = Static<typeof ConversationSendResultSchema>;
export type ConversationTurnParams = Static<typeof ConversationTurnParamsSchema>;
export type ConversationTurnCancelParams = Static<typeof ConversationTurnCancelParamsSchema>;
export type ConversationTurnCancelResult = Static<typeof ConversationTurnCancelResultSchema>;
export type ConversationTurnReply = Static<typeof ConversationTurnReplySchema>;
export type ConversationTurnResult = Static<typeof ConversationTurnResultSchema>;
export type MessageActionParams = Static<typeof MessageActionParamsSchema>;
export type PollParams = Static<typeof PollParamsSchema>;
export type AgentWaitParams = Static<typeof AgentWaitParamsSchema>;
export type WakeParams = Static<typeof WakeParamsSchema>;
