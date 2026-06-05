// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString, SecretInputSchema } from "./primitives.js";

/**
 * Channel and Talk protocol schemas.
 *
 * Talk schemas are consumed by browser realtime clients, gateway relay sessions,
 * and channel adapters, so the mode/transport/brain unions below are shared
 * API vocabulary rather than provider-local implementation details.
 */

/** Toggles Talk mode for the gateway, with an optional rollout phase marker. */
export const TalkModeParamsSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    phase: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Reads Talk configuration; secrets are included only for trusted callers. */
export const TalkConfigParamsSchema = Type.Object(
  {
    includeSecrets: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** One-shot text-to-speech request with provider-specific voice tuning knobs. */
export const TalkSpeakParamsSchema = Type.Object(
  {
    text: NonEmptyString,
    voiceId: Type.Optional(Type.String()),
    modelId: Type.Optional(Type.String()),
    outputFormat: Type.Optional(Type.String()),
    speed: Type.Optional(Type.Number()),
    rateWpm: Type.Optional(Type.Integer({ minimum: 1 })),
    stability: Type.Optional(Type.Number()),
    similarity: Type.Optional(Type.Number()),
    style: Type.Optional(Type.Number()),
    speakerBoost: Type.Optional(Type.Boolean()),
    seed: Type.Optional(Type.Integer({ minimum: 0 })),
    normalize: Type.Optional(Type.String()),
    language: Type.Optional(Type.String()),
    latencyTier: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

/** Supported Talk session shapes exposed to clients and providers. */
const TalkModeSchema = Type.Union([
  Type.Literal("realtime"),
  Type.Literal("stt-tts"),
  Type.Literal("transcription"),
]);

/** Transport families; browser clients branch on this value to choose setup flow. */
const TalkTransportSchema = Type.Union([
  Type.Literal("webrtc"),
  Type.Literal("provider-websocket"),
  Type.Literal("gateway-relay"),
  Type.Literal("managed-room"),
]);

/** How a Talk session delegates reasoning/tool use to the agent runtime. */
const TalkBrainSchema = Type.Union([
  Type.Literal("agent-consult"),
  Type.Literal("direct-tools"),
  Type.Literal("none"),
]);

/** Agent control actions accepted from Talk clients and managed rooms. */
const TalkAgentControlModeSchema = Type.Union([
  Type.Literal("status"),
  Type.Literal("steer"),
  Type.Literal("cancel"),
  Type.Literal("followup"),
]);

/** Stable event names emitted by Talk sessions across providers/transports. */
const TalkEventTypeSchema = Type.Union([
  Type.Literal("session.started"),
  Type.Literal("session.ready"),
  Type.Literal("session.closed"),
  Type.Literal("session.error"),
  Type.Literal("session.replaced"),
  Type.Literal("turn.started"),
  Type.Literal("turn.ended"),
  Type.Literal("turn.cancelled"),
  Type.Literal("capture.started"),
  Type.Literal("capture.stopped"),
  Type.Literal("capture.cancelled"),
  Type.Literal("capture.once"),
  Type.Literal("input.audio.delta"),
  Type.Literal("input.audio.committed"),
  Type.Literal("transcript.delta"),
  Type.Literal("transcript.done"),
  Type.Literal("output.text.delta"),
  Type.Literal("output.text.done"),
  Type.Literal("output.audio.started"),
  Type.Literal("output.audio.delta"),
  Type.Literal("output.audio.done"),
  Type.Literal("tool.call"),
  Type.Literal("tool.progress"),
  Type.Literal("tool.result"),
  Type.Literal("tool.error"),
  Type.Literal("usage.metrics"),
  Type.Literal("latency.metrics"),
  Type.Literal("health.changed"),
]);

/** Event types that must carry a turn id for client-side stream correlation. */
const TURN_SCOPED_TALK_EVENT_TYPES = [
  "turn.started",
  "turn.ended",
  "turn.cancelled",
  "input.audio.delta",
  "input.audio.committed",
  "transcript.delta",
  "transcript.done",
  "output.text.delta",
  "output.text.done",
  "output.audio.started",
  "output.audio.delta",
  "output.audio.done",
  "tool.call",
  "tool.progress",
  "tool.result",
  "tool.error",
];

/** Capture lifecycle events must include capture id to avoid cross-turn ambiguity. */
const CAPTURE_SCOPED_TALK_EVENT_TYPES = [
  "capture.started",
  "capture.stopped",
  "capture.cancelled",
  "capture.once",
];

/** Builds JSON Schema conditional requirements while avoiding reserved word syntax. */
function requireJsonSchemaProperties(properties: string[]): Record<string, { required: string[] }> {
  const conditionalRequirementKey = ["th", "en"].join("");
  return Object.fromEntries([[conditionalRequirementKey, { required: properties }]]);
}

/** Canonical Talk event envelope emitted to browser, relay, and channel consumers. */
export const TalkEventSchema = Type.Object(
  {
    id: NonEmptyString,
    type: TalkEventTypeSchema,
    sessionId: NonEmptyString,
    turnId: Type.Optional(Type.String()),
    captureId: Type.Optional(Type.String()),
    seq: Type.Integer({ minimum: 1 }),
    timestamp: NonEmptyString,
    mode: TalkModeSchema,
    transport: TalkTransportSchema,
    brain: TalkBrainSchema,
    provider: Type.Optional(Type.String()),
    final: Type.Optional(Type.Boolean()),
    callId: Type.Optional(Type.String()),
    itemId: Type.Optional(Type.String()),
    parentId: Type.Optional(Type.String()),
    payload: Type.Unknown(),
  },
  {
    additionalProperties: false,
    allOf: [
      {
        if: {
          properties: { type: { enum: TURN_SCOPED_TALK_EVENT_TYPES } },
          required: ["type"],
        },
        ...requireJsonSchemaProperties(["turnId"]),
      },
      {
        if: {
          properties: { type: { enum: CAPTURE_SCOPED_TALK_EVENT_TYPES } },
          required: ["type"],
        },
        ...requireJsonSchemaProperties(["captureId"]),
      },
    ],
  },
);

/** Creates a browser-facing Talk client session. */
export const TalkClientCreateParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    voice: Type.Optional(Type.String()),
    vadThreshold: Type.Optional(Type.Number()),
    silenceDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
    prefixPaddingMs: Type.Optional(Type.Integer({ minimum: 0 })),
    reasoningEffort: Type.Optional(Type.String()),
    mode: Type.Optional(TalkModeSchema),
    transport: Type.Optional(TalkTransportSchema),
    brain: Type.Optional(TalkBrainSchema),
  },
  { additionalProperties: false },
);

/** Tool-call request from a browser/client session back into the agent runtime. */
export const TalkClientToolCallParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    callId: NonEmptyString,
    name: NonEmptyString,
    args: Type.Optional(Type.Unknown()),
    relaySessionId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Agent run identity returned after accepting a Talk client tool call. */
export const TalkClientToolCallResultSchema = Type.Object(
  {
    runId: NonEmptyString,
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Text steering request for a Talk session bound to an agent turn. */
export const TalkClientSteerParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    text: NonEmptyString,
    mode: Type.Optional(TalkAgentControlModeSchema),
  },
  { additionalProperties: false },
);

/** Result of applying agent control to an embedded or reply-backed Talk run. */
export const TalkAgentControlResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    mode: TalkAgentControlModeSchema,
    sessionKey: NonEmptyString,
    sessionId: Type.Optional(NonEmptyString),
    active: Type.Boolean(),
    queued: Type.Optional(Type.Boolean()),
    aborted: Type.Optional(Type.Boolean()),
    target: Type.Optional(Type.Union([Type.Literal("embedded_run"), Type.Literal("reply_run")])),
    reason: Type.Optional(Type.String()),
    message: Type.String(),
    speak: Type.Boolean(),
    show: Type.Boolean(),
    suppress: Type.Boolean(),
    providerResult: Type.Optional(
      Type.Object(
        {
          status: Type.Literal("cancelled"),
          message: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    enqueuedAtMs: Type.Optional(Type.Number()),
    deliveredAtMs: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

/** Joins an existing managed-room Talk session. */
export const TalkSessionJoinParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    token: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Creates a gateway-managed Talk session for realtime, transcription, or relay use. */
export const TalkSessionCreateParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(Type.String()),
    spawnedBy: Type.Optional(NonEmptyString),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    voice: Type.Optional(Type.String()),
    vadThreshold: Type.Optional(Type.Number()),
    silenceDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
    prefixPaddingMs: Type.Optional(Type.Integer({ minimum: 0 })),
    reasoningEffort: Type.Optional(Type.String()),
    mode: Type.Optional(TalkModeSchema),
    transport: Type.Optional(TalkTransportSchema),
    brain: Type.Optional(TalkBrainSchema),
    ttlMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3600000 })),
  },
  { additionalProperties: false },
);

/** Appends base64 audio to an active Talk session. */
export const TalkSessionAppendAudioParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    audioBase64: NonEmptyString,
    timestamp: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

/** Starts or advances a Talk turn within a session. */
export const TalkSessionTurnParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    turnId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Cancels the active or named Talk turn. */
export const TalkSessionCancelTurnParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    turnId: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Cancels currently streaming Talk output without necessarily ending the turn. */
export const TalkSessionCancelOutputParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    turnId: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Submits a tool result back to a Talk provider session. */
export const TalkSessionSubmitToolResultParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    callId: NonEmptyString,
    result: Type.Unknown(),
    options: Type.Optional(
      Type.Object(
        {
          suppressResponse: Type.Optional(Type.Boolean()),
          willContinue: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** Steers a managed Talk session by session id rather than transcript key. */
export const TalkSessionSteerParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    sessionKey: Type.Optional(NonEmptyString),
    text: NonEmptyString,
    mode: Type.Optional(TalkAgentControlModeSchema),
  },
  { additionalProperties: false },
);

/** Closes a gateway-managed Talk session. */
export const TalkSessionCloseParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Mutable room state returned when a client joins a managed Talk room. */
const TalkSessionManagedRoomStateSchema = Type.Object(
  {
    activeClientId: Type.Optional(Type.String()),
    activeTurnId: Type.Optional(Type.String()),
    recentTalkEvents: Type.Array(TalkEventSchema),
  },
  { additionalProperties: false },
);

/** Managed-room session record shared with browser clients. */
const TalkSessionManagedRoomRecordSchema = Type.Object(
  {
    id: NonEmptyString,
    roomId: NonEmptyString,
    roomUrl: NonEmptyString,
    sessionKey: NonEmptyString,
    sessionId: Type.Optional(Type.String()),
    channel: Type.Optional(Type.String()),
    target: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    voice: Type.Optional(Type.String()),
    mode: TalkModeSchema,
    transport: TalkTransportSchema,
    brain: TalkBrainSchema,
    createdAt: Type.Number(),
    expiresAt: Type.Number(),
    room: TalkSessionManagedRoomStateSchema,
  },
  { additionalProperties: false },
);

/** Empty request payload for reading configured Talk provider capabilities. */
export const TalkCatalogParamsSchema = Type.Object({}, { additionalProperties: false });

/** One provider entry in the Talk capability catalog. */
const TalkCatalogProviderSchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    configured: Type.Boolean(),
    models: Type.Optional(Type.Array(Type.String())),
    voices: Type.Optional(Type.Array(Type.String())),
    defaultModel: Type.Optional(Type.String()),
    modes: Type.Optional(Type.Array(TalkModeSchema)),
    transports: Type.Optional(Type.Array(TalkTransportSchema)),
    brains: Type.Optional(Type.Array(TalkBrainSchema)),
    inputAudioFormats: Type.Optional(
      Type.Array(
        Type.Object(
          {
            encoding: Type.Union([Type.Literal("pcm16"), Type.Literal("g711_ulaw")]),
            sampleRateHz: Type.Integer({ minimum: 1 }),
            channels: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    outputAudioFormats: Type.Optional(
      Type.Array(
        Type.Object(
          {
            encoding: Type.Union([Type.Literal("pcm16"), Type.Literal("g711_ulaw")]),
            sampleRateHz: Type.Integer({ minimum: 1 }),
            channels: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    supportsBrowserSession: Type.Optional(Type.Boolean()),
    supportsBargeIn: Type.Optional(Type.Boolean()),
    supportsToolCalls: Type.Optional(Type.Boolean()),
    supportsVideoFrames: Type.Optional(Type.Boolean()),
    supportsSessionResumption: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Active provider plus all candidates for a Talk capability family. */
const TalkCatalogProviderGroupSchema = Type.Object(
  {
    activeProvider: Type.Optional(Type.String()),
    providers: Type.Array(TalkCatalogProviderSchema),
  },
  { additionalProperties: false },
);

/** Provider, mode, transport, and audio-format catalog returned to clients. */
export const TalkCatalogResultSchema = Type.Object(
  {
    modes: Type.Array(TalkModeSchema),
    transports: Type.Array(TalkTransportSchema),
    brains: Type.Array(TalkBrainSchema),
    speech: TalkCatalogProviderGroupSchema,
    transcription: TalkCatalogProviderGroupSchema,
    realtime: TalkCatalogProviderGroupSchema,
  },
  { additionalProperties: false },
);

/** Audio format contract for realtime browser sessions. */
const BrowserRealtimeAudioContractSchema = Type.Object(
  {
    inputEncoding: Type.Union([Type.Literal("pcm16"), Type.Literal("g711_ulaw")]),
    inputSampleRateHz: Type.Integer({ minimum: 1 }),
    outputEncoding: Type.Union([Type.Literal("pcm16"), Type.Literal("g711_ulaw")]),
    outputSampleRateHz: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

/** Session creation result with transport-specific ids and credentials. */
export const TalkSessionCreateResultSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    provider: Type.Optional(Type.String()),
    mode: TalkModeSchema,
    transport: TalkTransportSchema,
    brain: TalkBrainSchema,
    relaySessionId: Type.Optional(NonEmptyString),
    transcriptionSessionId: Type.Optional(NonEmptyString),
    handoffId: Type.Optional(NonEmptyString),
    roomId: Type.Optional(NonEmptyString),
    roomUrl: Type.Optional(NonEmptyString),
    token: Type.Optional(NonEmptyString),
    audio: Type.Optional(Type.Unknown()),
    model: Type.Optional(Type.String()),
    voice: Type.Optional(Type.String()),
    expiresAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

/** Result for a Talk turn request, optionally including emitted events. */
export const TalkSessionTurnResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    turnId: Type.Optional(Type.String()),
    events: Type.Optional(Type.Array(TalkEventSchema)),
  },
  { additionalProperties: false },
);

/** Managed-room record returned to clients after joining an existing Talk session. */
export const TalkSessionJoinResultSchema = TalkSessionManagedRoomRecordSchema;

/** Generic success result for Talk session lifecycle calls. */
export const TalkSessionOkResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Browser WebRTC setup payload using provider SDP exchange. */
const BrowserRealtimeWebRtcSdpSessionSchema = Type.Object(
  {
    provider: NonEmptyString,
    transport: Type.Literal("webrtc"),
    clientSecret: NonEmptyString,
    offerUrl: Type.Optional(Type.String()),
    offerHeaders: Type.Optional(Type.Record(Type.String(), Type.String())),
    model: Type.Optional(Type.String()),
    voice: Type.Optional(Type.String()),
    expiresAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

/** Browser websocket setup payload with JSON/PCM audio contract. */
const BrowserRealtimeJsonPcmWebSocketSessionSchema = Type.Object(
  {
    provider: NonEmptyString,
    transport: Type.Literal("provider-websocket"),
    protocol: NonEmptyString,
    clientSecret: NonEmptyString,
    websocketUrl: NonEmptyString,
    audio: BrowserRealtimeAudioContractSchema,
    initialMessage: Type.Optional(Type.Unknown()),
    model: Type.Optional(Type.String()),
    voice: Type.Optional(Type.String()),
    expiresAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

/** Browser setup payload for gateway-relayed realtime audio. */
const BrowserRealtimeGatewayRelaySessionSchema = Type.Object(
  {
    provider: NonEmptyString,
    transport: Type.Literal("gateway-relay"),
    relaySessionId: NonEmptyString,
    audio: BrowserRealtimeAudioContractSchema,
    model: Type.Optional(Type.String()),
    voice: Type.Optional(Type.String()),
    expiresAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

/** Browser setup payload for managed-room Talk sessions. */
const BrowserRealtimeManagedRoomSessionSchema = Type.Object(
  {
    provider: NonEmptyString,
    transport: Type.Literal("managed-room"),
    roomUrl: NonEmptyString,
    token: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    voice: Type.Optional(Type.String()),
    expiresAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

/** Union of all browser Talk session setup payloads. */
export const TalkClientCreateResultSchema = Type.Union([
  BrowserRealtimeWebRtcSdpSessionSchema,
  BrowserRealtimeJsonPcmWebSocketSessionSchema,
  BrowserRealtimeGatewayRelaySessionSchema,
  BrowserRealtimeManagedRoomSessionSchema,
]);

/** Secret-bearing provider fields; extra provider options remain provider-owned. */
const talkProviderFieldSchemas = {
  apiKey: Type.Optional(SecretInputSchema),
};

/** Per-provider Talk config bag. */
const TalkProviderConfigSchema = Type.Object(talkProviderFieldSchemas, {
  additionalProperties: true,
});

/** Realtime Talk defaults and provider selection stored in config. */
const TalkRealtimeConfigSchema = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    providers: Type.Optional(Type.Record(Type.String(), TalkProviderConfigSchema)),
    model: Type.Optional(Type.String()),
    speakerVoice: Type.Optional(Type.String()),
    speakerVoiceId: Type.Optional(Type.String()),
    voice: Type.Optional(Type.String()),
    instructions: Type.Optional(Type.String()),
    mode: Type.Optional(TalkModeSchema),
    transport: Type.Optional(TalkTransportSchema),
    brain: Type.Optional(TalkBrainSchema),
  },
  { additionalProperties: false },
);

/** Resolved active Talk provider plus its normalized provider config. */
const ResolvedTalkConfigSchema = Type.Object(
  {
    provider: Type.String(),
    config: TalkProviderConfigSchema,
  },
  { additionalProperties: false },
);

/** Talk config subtree returned through gateway config APIs. */
const TalkConfigSchema = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    providers: Type.Optional(Type.Record(Type.String(), TalkProviderConfigSchema)),
    realtime: Type.Optional(TalkRealtimeConfigSchema),
    resolved: Type.Optional(ResolvedTalkConfigSchema),
    consultThinkingLevel: Type.Optional(Type.String()),
    consultFastMode: Type.Optional(Type.Boolean()),
    speechLocale: Type.Optional(Type.String()),
    interruptOnSpeech: Type.Optional(Type.Boolean()),
    silenceTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

/** Full Talk config read result, including related session/UI context. */
export const TalkConfigResultSchema = Type.Object(
  {
    config: Type.Object(
      {
        talk: Type.Optional(TalkConfigSchema),
        session: Type.Optional(
          Type.Object(
            {
              mainKey: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
        ui: Type.Optional(
          Type.Object(
            {
              seamColor: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** Text-to-speech result with encoded audio and provider output metadata. */
export const TalkSpeakResultSchema = Type.Object(
  {
    audioBase64: NonEmptyString,
    provider: NonEmptyString,
    outputFormat: Type.Optional(Type.String()),
    voiceCompatible: Type.Optional(Type.Boolean()),
    mimeType: Type.Optional(Type.String()),
    fileExtension: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Channel status request, optionally probing one channel before returning. */
export const ChannelsStatusParamsSchema = Type.Object(
  {
    probe: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    channel: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/**
 * Per-account status snapshot for channel docking.
 *
 * This is intentionally schema-light so new channel-specific metadata can ship
 * without a gateway protocol update; known fields stay documented for UI use.
 */
export const ChannelAccountSnapshotSchema = Type.Object(
  {
    accountId: NonEmptyString,
    name: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
    configured: Type.Optional(Type.Boolean()),
    linked: Type.Optional(Type.Boolean()),
    running: Type.Optional(Type.Boolean()),
    connected: Type.Optional(Type.Boolean()),
    reconnectAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
    lastConnectedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastError: Type.Optional(Type.String()),
    healthState: Type.Optional(Type.String()),
    lastStartAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastStopAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastInboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastOutboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastTransportActivityAt: Type.Optional(Type.Integer({ minimum: 0 })),
    busy: Type.Optional(Type.Boolean()),
    activeRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunActivityAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastProbeAt: Type.Optional(Type.Integer({ minimum: 0 })),
    mode: Type.Optional(Type.String()),
    dmPolicy: Type.Optional(Type.String()),
    allowFrom: Type.Optional(Type.Array(Type.String())),
    tokenSource: Type.Optional(Type.String()),
    botTokenSource: Type.Optional(Type.String()),
    appTokenSource: Type.Optional(Type.String()),
    baseUrl: Type.Optional(Type.String()),
    allowUnmentionedGroups: Type.Optional(Type.Boolean()),
    cliPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    dbPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    port: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    probe: Type.Optional(Type.Unknown()),
    audit: Type.Optional(Type.Unknown()),
    application: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

/** UI label and icon metadata for one channel. */
export const ChannelUiMetaSchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    detailLabel: NonEmptyString,
    systemImage: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Event-loop health snapshot included with channel status responses. */
export const ChannelEventLoopHealthSchema = Type.Object(
  {
    degraded: Type.Boolean(),
    reasons: Type.Array(
      Type.Union([
        Type.Literal("event_loop_delay"),
        Type.Literal("event_loop_utilization"),
        Type.Literal("cpu"),
      ]),
    ),
    intervalMs: Type.Integer({ minimum: 0 }),
    delayP99Ms: Type.Number({ minimum: 0 }),
    delayMaxMs: Type.Number({ minimum: 0 }),
    utilization: Type.Number({ minimum: 0 }),
    cpuCoreRatio: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Full channel status result for dashboard and operator diagnostics. */
export const ChannelsStatusResultSchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
    channelOrder: Type.Array(NonEmptyString),
    channelLabels: Type.Record(NonEmptyString, NonEmptyString),
    channelDetailLabels: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
    channelSystemImages: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
    channelMeta: Type.Optional(Type.Array(ChannelUiMetaSchema)),
    channels: Type.Record(NonEmptyString, Type.Unknown()),
    channelAccounts: Type.Record(NonEmptyString, Type.Array(ChannelAccountSnapshotSchema)),
    channelDefaultAccountId: Type.Record(NonEmptyString, NonEmptyString),
    eventLoop: Type.Optional(ChannelEventLoopHealthSchema),
    partial: Type.Optional(Type.Boolean()),
    warnings: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

/** Logs out one channel account. */
export const ChannelsLogoutParamsSchema = Type.Object(
  {
    channel: NonEmptyString,
    accountId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Stops one channel account runtime. */
export const ChannelsStopParamsSchema = Type.Object(
  {
    channel: NonEmptyString,
    accountId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Starts one channel account runtime. */
export const ChannelsStartParamsSchema = Type.Object(
  {
    channel: NonEmptyString,
    accountId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Starts browser/web login for a channel account. */
export const WebLoginStartParamsSchema = Type.Object(
  {
    force: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    verbose: Type.Optional(Type.Boolean()),
    accountId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const QrDataUrlSchema = Type.String({
  maxLength: 16_384,
  pattern: "^data:image/png;base64,",
});

/** Waits for web login completion or the next QR code. */
export const WebLoginWaitParamsSchema = Type.Object(
  {
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    accountId: Type.Optional(Type.String()),
    currentQrDataUrl: Type.Optional(QrDataUrlSchema),
  },
  { additionalProperties: false },
);
