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

export const TalkRealtimeSessionParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    voice: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TalkRealtimeRelayAudioParamsSchema = Type.Object(
  {
    relaySessionId: NonEmptyString,
    audioBase64: NonEmptyString,
    timestamp: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export const TalkRealtimeRelayMarkParamsSchema = Type.Object(
  {
    relaySessionId: NonEmptyString,
    markName: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TalkRealtimeRelayStopParamsSchema = Type.Object(
  {
    relaySessionId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TalkRealtimeRelayToolResultParamsSchema = Type.Object(
  {
    relaySessionId: NonEmptyString,
    callId: NonEmptyString,
    result: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const TalkRealtimeRelayOkResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
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

const BrowserRealtimeWebRtcSdpSessionSchema = Type.Object(
  {
    provider: NonEmptyString,
    transport: Type.Optional(Type.Literal("webrtc-sdp")),
    clientSecret: NonEmptyString,
    offerUrl: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    voice: Type.Optional(Type.String()),
    expiresAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

const BrowserRealtimeJsonPcmWebSocketSessionSchema = Type.Object(
  {
    provider: NonEmptyString,
    transport: Type.Literal("json-pcm-websocket"),
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

export const TalkRealtimeSessionResultSchema = Type.Union([
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
    resolved: ResolvedTalkConfigSchema,
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
