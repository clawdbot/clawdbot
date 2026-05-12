import { Type } from "typebox";
import { NonEmptyString, SecretInputSchema } from "./primitives.js";

export const TalkModeParamsSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    phase: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TalkConfigParamsSchema = Type.Object(
  {
    includeSecrets: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

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

const TalkModeSchema = Type.Union([
  Type.Literal("realtime"),
  Type.Literal("stt-tts"),
  Type.Literal("transcription"),
]);

const TalkTransportSchema = Type.Union([
  Type.Literal("webrtc"),
  Type.Literal("provider-websocket"),
  Type.Literal("gateway-relay"),
  Type.Literal("managed-room"),
]);

const TalkBrainSchema = Type.Union([
  Type.Literal("agent-consult"),
  Type.Literal("direct-tools"),
  Type.Literal("none"),
]);

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

const CAPTURE_SCOPED_TALK_EVENT_TYPES = [
  "capture.started",
  "capture.stopped",
  "capture.cancelled",
  "capture.once",
];

function requireJsonSchemaProperties(properties: string[]): Record<string, { required: string[] }> {
  const conditionalRequirementKey = ["th", "en"].join("");
  return Object.fromEntries([[conditionalRequirementKey, { required: properties }]]);
}

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

export const TalkClientToolCallResultSchema = Type.Object(
  {
    runId: NonEmptyString,
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TalkSessionJoinParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    token: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TalkSessionCreateParamsSchema = Type.Object(
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
    ttlMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3600000 })),
  },
  { additionalProperties: false },
);

export const TalkSessionAppendAudioParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    audioBase64: NonEmptyString,
    timestamp: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export const TalkSessionTurnParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    turnId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TalkSessionCancelTurnParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    turnId: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TalkSessionCancelOutputParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    turnId: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

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

export const TalkSessionCloseParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
  },
  { additionalProperties: false },
);

const TalkSessionManagedRoomStateSchema = Type.Object(
  {
    activeClientId: Type.Optional(Type.String()),
    activeTurnId: Type.Optional(Type.String()),
    recentTalkEvents: Type.Array(TalkEventSchema),
  },
  { additionalProperties: false },
);

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

export const TalkCatalogParamsSchema = Type.Object({}, { additionalProperties: false });

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

const TalkCatalogProviderGroupSchema = Type.Object(
  {
    activeProvider: Type.Optional(Type.String()),
    providers: Type.Array(TalkCatalogProviderSchema),
  },
  { additionalProperties: false },
);

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

const BrowserRealtimeAudioContractSchema = Type.Object(
  {
    inputEncoding: Type.Union([Type.Literal("pcm16"), Type.Literal("g711_ulaw")]),
    inputSampleRateHz: Type.Integer({ minimum: 1 }),
    outputEncoding: Type.Union([Type.Literal("pcm16"), Type.Literal("g711_ulaw")]),
    outputSampleRateHz: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

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

export const TalkSessionTurnResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    turnId: Type.Optional(Type.String()),
    events: Type.Optional(Type.Array(TalkEventSchema)),
  },
  { additionalProperties: false },
);

export const TalkSessionJoinResultSchema = TalkSessionManagedRoomRecordSchema;

export const TalkSessionOkResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
  },
  { additionalProperties: false },
);

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

export const TalkClientCreateResultSchema = Type.Union([
  BrowserRealtimeWebRtcSdpSessionSchema,
  BrowserRealtimeJsonPcmWebSocketSessionSchema,
  BrowserRealtimeGatewayRelaySessionSchema,
  BrowserRealtimeManagedRoomSessionSchema,
]);

const talkProviderFieldSchemas = {
  apiKey: Type.Optional(SecretInputSchema),
};

const TalkProviderConfigSchema = Type.Object(talkProviderFieldSchemas, {
  additionalProperties: true,
});

const TalkRealtimeConfigSchema = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    providers: Type.Optional(Type.Record(Type.String(), TalkProviderConfigSchema)),
    model: Type.Optional(Type.String()),
    voice: Type.Optional(Type.String()),
    instructions: Type.Optional(Type.String()),
    mode: Type.Optional(TalkModeSchema),
    transport: Type.Optional(TalkTransportSchema),
    brain: Type.Optional(TalkBrainSchema),
  },
  { additionalProperties: false },
);

const ResolvedTalkConfigSchema = Type.Object(
  {
    provider: Type.String(),
    config: TalkProviderConfigSchema,
  },
  { additionalProperties: false },
);

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

export const ChannelsStatusParamsSchema = Type.Object(
  {
    probe: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    channel: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

// Channel docking: channels.status is intentionally schema-light so new
// channels can ship without protocol updates.
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

export const ChannelUiMetaSchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    detailLabel: NonEmptyString,
    systemImage: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

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

export const ChannelsLogoutParamsSchema = Type.Object(
  {
    channel: NonEmptyString,
    accountId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ChannelsStopParamsSchema = Type.Object(
  {
    channel: NonEmptyString,
    accountId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ChannelsStartParamsSchema = Type.Object(
  {
    channel: NonEmptyString,
    accountId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

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

export const WebLoginWaitParamsSchema = Type.Object(
  {
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    accountId: Type.Optional(Type.String()),
    currentQrDataUrl: Type.Optional(QrDataUrlSchema),
  },
  { additionalProperties: false },
);
