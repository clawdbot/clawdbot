// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
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

/** Generated media/file attachment metadata carried by internal agent events. */
export const AgentGeneratedAttachmentSchema = Type.Object(
  {
    type: Type.Optional(Type.String({ enum: ["image", "audio", "video", "file"] })),
    path: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    mediaUrl: Type.Optional(Type.String()),
    filePath: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Internal completion event surfaced when child automation reports back to a parent run. */
export const AgentInternalEventSchema = Type.Object(
  {
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
  },
  { additionalProperties: false },
);

/** Stream event emitted by the agent runtime over the gateway protocol. */
export const AgentEventSchema = Type.Object(
  {
    runId: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    stream: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
    spawnedBy: Type.Optional(NonEmptyString),
    isHeartbeat: Type.Optional(Type.Boolean()),
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

/** Channel context injected into message actions so tools can reply in-place. */
export const MessageActionToolContextSchema = Type.Object(
  {
    currentChannelId: Type.Optional(Type.String()),
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
      Type.Object(
        {
          value: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    skipCrossContextDecoration: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Request to execute a channel message action through a configured adapter. */
export const MessageActionParamsSchema = Type.Object(
  {
    channel: NonEmptyString,
    action: NonEmptyString,
    params: Type.Record(Type.String(), Type.Unknown()),
    accountId: Type.Optional(Type.String()),
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
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Outbound send request shared by channel adapters. */
export const SendParamsSchema = Type.Object(
  {
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
  },
  { additionalProperties: false },
);

/** Poll creation request for adapters that support native polls. */
export const PollParamsSchema = Type.Object(
  {
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
  },
  { additionalProperties: false },
);

/** Main agent-run request accepted by the gateway. */
export const AgentParamsSchema = Type.Object(
  {
    message: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    replyTo: Type.Optional(Type.String()),
    sessionId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
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
    // Backward-compatible no-op. Older CLI clients sent this field on gateway
    // agent requests; the gateway accepts but intentionally ignores it.
    cleanupBundleMcpOnRunEnd: Type.Optional(Type.Boolean()),
    modelRun: Type.Optional(Type.Boolean()),
    promptMode: Type.Optional(
      Type.Union([Type.Literal("full"), Type.Literal("minimal"), Type.Literal("none")]),
    ),
    extraSystemPrompt: Type.Optional(Type.String()),
    bootstrapContextMode: Type.Optional(
      Type.Union([Type.Literal("full"), Type.Literal("lightweight")]),
    ),
    bootstrapContextRunKind: Type.Optional(
      Type.Union([Type.Literal("default"), Type.Literal("heartbeat"), Type.Literal("cron")]),
    ),
    acpTurnSource: Type.Optional(Type.Literal("manual_spawn")),
    internalRuntimeHandoffId: Type.Optional(NonEmptyString),
    internalEvents: Type.Optional(Type.Array(AgentInternalEventSchema)),
    inputProvenance: Type.Optional(InputProvenanceSchema),
    suppressPromptPersistence: Type.Optional(Type.Boolean()),
    sessionEffects: Type.Optional(Type.Union([Type.Literal("visible"), Type.Literal("internal")])),
    sourceReplyDeliveryMode: Type.Optional(
      Type.Union([Type.Literal("automatic"), Type.Literal("message_tool_only")]),
    ),
    disableMessageTool: Type.Optional(Type.Boolean()),
    voiceWakeTrigger: Type.Optional(Type.String()),
    idempotencyKey: NonEmptyString,
    label: Type.Optional(SessionLabelString),
  },
  { additionalProperties: false },
);

/** Identity lookup request for the current or selected agent/session. */
export const AgentIdentityParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Public display identity returned for an agent. */
export const AgentIdentityResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    avatar: Type.Optional(NonEmptyString),
    avatarSource: Type.Optional(NonEmptyString),
    avatarStatus: Type.Optional(Type.String({ enum: ["none", "local", "remote", "data"] })),
    avatarReason: Type.Optional(NonEmptyString),
    emoji: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Waits for a submitted agent run to complete or time out. */
export const AgentWaitParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

/** Wake request from external schedulers or devices into an agent session. */
export const WakeParamsSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")]),
    text: NonEmptyString,
    // Typed field; misspelled variants remain opaque metadata because wake
    // senders already rely on additionalProperties.
    sessionKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: true }, // external wake senders may attach opaque metadata
);
