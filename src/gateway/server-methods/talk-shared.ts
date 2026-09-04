// Talk shared helpers build provider configs, launch options, tool schemas, and
// room event broadcasts used by browser and gateway-owned Talk sessions.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveRealtimeBootstrapContextInstructions } from "../../agents/realtime-bootstrap-context.js";
import type { TalkRealtimeConfig } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { RealtimeVoiceProviderPlugin } from "../../plugins/types.js";
import {
  getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders,
} from "../../realtime-transcription/provider-registry.js";
import type { RealtimeTranscriptionProviderConfig } from "../../realtime-transcription/provider-types.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME } from "../../talk/agent-run-control-shared.js";
import { resolveInternalRealtimeVoiceGatewayRelayLaunchError } from "../../talk/provider-internal.js";
import { listRealtimeVoiceProviders } from "../../talk/provider-registry.js";
import type {
  RealtimeVoiceBrowserSession,
  RealtimeVoiceProviderConfig,
} from "../../talk/provider-types.js";
import type { TalkBrain, TalkEvent, TalkMode, TalkTransport } from "../../talk/talk-events.js";
import {
  getVoiceProviderConfig,
  providerMatchesId,
  resolveSupportedVoiceModelRefs,
  type VoiceModelProvider,
} from "../../tts/voice-models.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";

/** Resolve the Talk session mode, defaulting managed-room transports to stt-tts. */
export function normalizeTalkSessionMode(params: { mode?: string; transport?: string }): TalkMode {
  return (
    (normalizeOptionalLowercaseString(params.mode) as TalkMode | undefined) ??
    (normalizeOptionalLowercaseString(params.transport) === "managed-room" ? "stt-tts" : "realtime")
  );
}

/** Resolve the Talk session transport from mode when the client omits it. */
export function normalizeTalkSessionTransport(params: {
  mode: TalkMode;
  transport?: string;
}): TalkTransport {
  const transport = normalizeOptionalLowercaseString(params.transport) as TalkTransport | undefined;
  if (transport) {
    return transport;
  }
  return params.mode === "stt-tts" ? "managed-room" : "gateway-relay";
}

/** Resolve the Talk session brain, defaulting transcription sessions to none. */
export function normalizeTalkSessionBrain(params: { mode: TalkMode; brain?: string }): TalkBrain {
  const brain = normalizeOptionalLowercaseString(params.brain) as TalkBrain | undefined;
  if (brain) {
    return brain;
  }
  return params.mode === "transcription" ? "none" : "agent-consult";
}

export async function resolveTalkRealtimeProviderInstructions(params: {
  config: OpenClawConfig;
  agentId: string;
  configuredInstructions?: string;
  sessionKey: string;
  warn: (message: string) => void;
}): Promise<string> {
  const bootstrapContext = await resolveRealtimeBootstrapContextInstructions(params);
  return [params.configuredInstructions, bootstrapContext]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join("\n\n");
}

export function canUseTalkDirectTools(client: { connect?: { scopes?: string[] } } | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

export function broadcastTalkRoomEvents(
  context: {
    broadcastToConnIds: (
      event: string,
      payload: unknown,
      connIds: Set<string>,
      opts?: { dropIfSlow?: boolean },
    ) => void;
  },
  connId: string | undefined,
  params: { handoffId: string; roomId: string; events: TalkEvent[] },
): void {
  if (!connId || params.events.length === 0) {
    return;
  }
  for (const talkEvent of params.events) {
    context.broadcastToConnIds(
      "talk.event",
      { handoffId: params.handoffId, roomId: params.roomId, talkEvent },
      new Set([connId]),
      { dropIfSlow: true },
    );
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return asOptionalRecord(value) ?? undefined;
}

function singleRecordKey(record: Record<string, unknown> | undefined): string | undefined {
  const keys = record ? Object.keys(record) : [];
  return keys.length === 1 ? keys[0] : undefined;
}

function normalizeRealtimeTransport(value: unknown): TalkRealtimeConfig["transport"] {
  const transport = normalizeOptionalLowercaseString(value);
  return transport === "webrtc" ||
    transport === "provider-websocket" ||
    transport === "gateway-relay" ||
    transport === "managed-room"
    ? transport
    : undefined;
}

function getVoiceCallProviderConfig<TConfig extends Record<string, unknown>>(
  config: OpenClawConfig,
  sectionName: "realtime" | "streaming",
): {
  provider?: string;
  providers?: Record<string, TConfig>;
} {
  const plugins = getRecord(config.plugins);
  const entries = getRecord(plugins?.entries);
  const voiceCall = getRecord(entries?.["voice-call"]);
  const pluginConfig = getRecord(voiceCall?.config);
  const section = getRecord(pluginConfig?.[sectionName]);
  const providersRaw = getRecord(section?.providers);
  const providers: Record<string, TConfig> = {};
  if (providersRaw) {
    for (const [providerId, providerConfig] of Object.entries(providersRaw)) {
      const record = getRecord(providerConfig);
      if (record) {
        providers[providerId] = record as TConfig;
      }
    }
  }
  return {
    provider: normalizeOptionalString(section?.provider),
    providers: Object.keys(providers).length > 0 ? providers : undefined,
  };
}

function getVoiceCallRealtimeConfig(config: OpenClawConfig): {
  provider?: string;
  providers?: Record<string, RealtimeVoiceProviderConfig>;
} {
  return getVoiceCallProviderConfig(config, "realtime");
}

function getVoiceCallStreamingConfig(config: OpenClawConfig): {
  provider?: string;
  providers?: Record<string, RealtimeTranscriptionProviderConfig>;
} {
  return getVoiceCallProviderConfig(config, "streaming");
}

export function listTalkTranscriptionProviders(
  config: OpenClawConfig,
  configuredProviderIds: Iterable<string | undefined>,
) {
  const providers = listRealtimeTranscriptionProviders(config);
  for (const providerId of configuredProviderIds) {
    const configuredProvider = getRealtimeTranscriptionProvider(providerId, config);
    if (
      configuredProvider &&
      !providers.some(
        (provider) =>
          normalizeOptionalLowercaseString(provider.id) ===
          normalizeOptionalLowercaseString(configuredProvider.id),
      )
    ) {
      providers.push(configuredProvider);
    }
  }
  return providers;
}

type RealtimeProviderWithConfig<TConfig extends Record<string, unknown>> = VoiceModelProvider & {
  resolveConfig?: (ctx: { cfg: OpenClawConfig; rawConfig: TConfig }) => TConfig;
  isConfigured: (ctx: { cfg: OpenClawConfig; providerConfig: TConfig }) => boolean;
};

function resolveConfiguredVoiceModelDefaultRef<TConfig extends Record<string, unknown>>(params: {
  config: OpenClawConfig;
  provider: string | undefined;
  providerConfigs: Record<string, TConfig>;
  providers: readonly RealtimeProviderWithConfig<TConfig>[];
  requestedModel?: string;
}): { provider: string; model: string } | undefined {
  const configuredProvider = normalizeOptionalString(params.provider);
  const refs = resolveSupportedVoiceModelRefs({
    config: params.config.agents?.defaults?.voiceModel,
    providers: params.providers,
    providerId: configuredProvider,
  });
  for (const ref of refs) {
    const provider = params.providers.find((entry) => providerMatchesId(entry, ref.provider));
    if (!provider) {
      continue;
    }
    if (!configuredProvider) {
      const rawConfig = getVoiceProviderConfig({
        providerConfigs: params.providerConfigs,
        provider,
      });
      const rawConfigWithModel = {
        ...rawConfig,
        model:
          params.requestedModel ?? (rawConfig.model === undefined ? ref.model : rawConfig.model),
      };
      const providerConfig =
        provider.resolveConfig?.({
          cfg: params.config,
          rawConfig: rawConfigWithModel,
        }) ?? rawConfigWithModel;
      if (!configuredOrFalse(() => provider.isConfigured({ cfg: params.config, providerConfig }))) {
        continue;
      }
    }
    return { provider: provider.id, model: ref.model };
  }
  return undefined;
}

export function buildTalkRealtimeConfig(
  config: OpenClawConfig,
  requestedProvider?: string,
  requestedModel?: string,
) {
  const voiceCallRealtime = getVoiceCallRealtimeConfig(config);
  const talkRealtime = getRecord(config.talk?.realtime);
  const talkRealtimeProviderConfigs = talkRealtime?.providers as
    | Record<string, RealtimeVoiceProviderConfig>
    | undefined;
  const explicitProvider =
    normalizeOptionalString(requestedProvider) ?? normalizeOptionalString(talkRealtime?.provider);
  const singleConfiguredProvider = normalizeOptionalString(
    singleRecordKey(talkRealtimeProviderConfigs),
  );
  const configuredProvider =
    explicitProvider ?? singleConfiguredProvider ?? voiceCallRealtime.provider;
  const selectedProvider = configuredProvider ?? singleConfiguredProvider;
  // Talk-local realtime config wins over the legacy voice-call plugin config,
  // while the legacy config remains a bridge for existing installations.
  const providerConfigs = {
    ...voiceCallRealtime.providers,
    ...talkRealtimeProviderConfigs,
  };
  const voiceModelDefault = resolveConfiguredVoiceModelDefaultRef({
    config,
    provider: selectedProvider,
    providerConfigs,
    providers: listRealtimeVoiceProviders(config),
    requestedModel:
      normalizeOptionalString(requestedModel) ?? normalizeOptionalString(talkRealtime?.model),
  });
  const provider = selectedProvider ?? voiceModelDefault?.provider;
  const model = normalizeOptionalString(talkRealtime?.model) ?? voiceModelDefault?.model;
  return {
    provider,
    providers: providerConfigs,
    model,
    // talk.realtime.voice is not a schema key (strictObject rejects it);
    // provider-level `voice` compat is owned by each provider's normalizer.
    voice:
      normalizeOptionalString(talkRealtime?.speakerVoice) ??
      normalizeOptionalString(talkRealtime?.speakerVoiceId),
    instructions: normalizeOptionalString(talkRealtime?.instructions),
    mode: normalizeOptionalLowercaseString(talkRealtime?.mode),
    transport: normalizeRealtimeTransport(talkRealtime?.transport),
    vadThreshold:
      typeof talkRealtime?.vadThreshold === "number" && Number.isFinite(talkRealtime.vadThreshold)
        ? talkRealtime.vadThreshold
        : undefined,
    silenceDurationMs:
      typeof talkRealtime?.silenceDurationMs === "number" &&
      Number.isFinite(talkRealtime.silenceDurationMs)
        ? talkRealtime.silenceDurationMs
        : undefined,
    prefixPaddingMs:
      typeof talkRealtime?.prefixPaddingMs === "number" &&
      Number.isFinite(talkRealtime.prefixPaddingMs)
        ? talkRealtime.prefixPaddingMs
        : undefined,
    reasoningEffort: normalizeOptionalString(talkRealtime?.reasoningEffort),
    brain: normalizeOptionalLowercaseString(talkRealtime?.brain),
    consultRouting: normalizeOptionalLowercaseString(talkRealtime?.consultRouting),
  };
}

export function buildTalkTranscriptionConfig(
  config: OpenClawConfig,
  requestedProvider?: string,
  requestedModel?: string,
) {
  const streamingConfig = getVoiceCallStreamingConfig(config);
  const provider = normalizeOptionalString(requestedProvider) ?? streamingConfig.provider;
  const providerConfigs = streamingConfig.providers ?? {};
  const configuredProviderIds = [provider, ...Object.keys(providerConfigs)];
  const voiceModelDefault = resolveConfiguredVoiceModelDefaultRef({
    config,
    provider,
    providerConfigs,
    providers: listTalkTranscriptionProviders(config, configuredProviderIds),
    requestedModel: normalizeOptionalString(requestedModel),
  });
  return {
    provider: provider ?? voiceModelDefault?.provider,
    providers: providerConfigs,
    model: voiceModelDefault?.model,
  };
}

export function configuredOrFalse(callback: () => boolean): boolean {
  try {
    return callback();
  } catch {
    return false;
  }
}

export function resolveConfiguredRealtimeTranscriptionProvider(params: {
  config: OpenClawConfig;
  configuredProviderId?: string;
  providerConfigs: Record<string, RealtimeTranscriptionProviderConfig>;
  requestedModel?: string;
  defaultModel?: string;
}) {
  const normalizedConfigured = normalizeOptionalLowercaseString(params.configuredProviderId);
  const providers = normalizedConfigured
    ? [getRealtimeTranscriptionProvider(normalizedConfigured, params.config)].filter(
        (provider) => provider !== undefined,
      )
    : listTalkTranscriptionProviders(params.config, Object.keys(params.providerConfigs));
  // An explicit provider is authoritative; automatic selection is stable by
  // provider order so the same config picks the same transcription backend.
  const orderedProviders = normalizedConfigured
    ? providers
    : providers.toSorted((a, b) => (a.autoSelectOrder ?? 1000) - (b.autoSelectOrder ?? 1000));
  for (const provider of orderedProviders) {
    const rawConfig = getVoiceProviderConfig({
      providerConfigs: params.providerConfigs,
      provider,
      configuredProviderId: params.configuredProviderId,
    });
    const model =
      params.requestedModel ?? (rawConfig.model === undefined ? params.defaultModel : undefined);
    const rawConfigWithModel = model ? { ...rawConfig, model } : rawConfig;
    const providerConfig =
      provider.resolveConfig?.({ cfg: params.config, rawConfig: rawConfigWithModel }) ??
      rawConfigWithModel;
    if (configuredOrFalse(() => provider.isConfigured({ cfg: params.config, providerConfig }))) {
      return { provider, providerConfig };
    }
  }
  if (normalizedConfigured) {
    throw new Error(
      `Realtime transcription provider "${params.configuredProviderId}" is not configured`,
    );
  }
  throw new Error("No realtime transcription provider registered");
}

const DEFAULT_REALTIME_INSTRUCTIONS = [
  "You are OpenClaw's realtime voice interface. Keep spoken replies concise.",
  `If the user asks for code, repository state, files, current OpenClaw context, tool-backed actions, or deeper reasoning, call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} and then summarize the result naturally.`,
  `Do not claim you cannot use tools, perform actions, or reach OpenClaw unless ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} returns that failure.`,
  `When ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} is in progress, speak one brief acknowledgement such as "Let me check that for you", then wait for the final OpenClaw result before answering with the actual result.`,
  `If OpenClaw is already working through ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} and the user asks in any language for progress, cancellation, a redirect/change, or a follow-up, call ${REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME} with the semantic mode.`,
  "For greetings and casual chatter while OpenClaw is working, answer naturally and do not redirect the active work.",
].join(" ");

export function buildRealtimeInstructions(configuredInstructions?: string): string {
  const extra = normalizeOptionalString(configuredInstructions);
  if (!extra) {
    return DEFAULT_REALTIME_INSTRUCTIONS;
  }
  // Keep the tool-use contract first, then append operator customization so
  // provider sessions preserve the same control-tool behavior.
  return `${DEFAULT_REALTIME_INSTRUCTIONS}\n\nAdditional realtime instructions:\n${extra}`;
}

type RealtimeVoiceLaunchOptions = {
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  reasoningEffort?: string;
};

type RealtimeVoiceLaunchOptionInput = {
  model?: unknown;
  voice?: unknown;
  vadThreshold?: unknown;
  silenceDurationMs?: unknown;
  prefixPaddingMs?: unknown;
  reasoningEffort?: unknown;
};

export function buildRealtimeVoiceLaunchOptions(params: {
  requested: RealtimeVoiceLaunchOptionInput;
  defaults: RealtimeVoiceLaunchOptions;
}): RealtimeVoiceLaunchOptions {
  const options = pickRealtimeVoiceLaunchOptions(params.defaults);
  // Per-request browser controls override config defaults, but only when they
  // are valid primitive values the realtime provider can consume.
  return {
    ...options,
    ...pickRealtimeVoiceLaunchOptions(params.requested),
  };
}

function withRealtimeBrowserOverrides(
  providerConfig: RealtimeVoiceProviderConfig,
  params: RealtimeVoiceLaunchOptionInput,
): RealtimeVoiceProviderConfig {
  const overrides: RealtimeVoiceProviderConfig = {};
  const model = normalizeOptionalString(params.model);
  const voice = normalizeOptionalString(params.voice);
  const reasoningEffort = normalizeOptionalString(params.reasoningEffort);
  if (model) {
    overrides.model = model;
  }
  if (voice) {
    overrides.voice = voice;
  }
  if (typeof params.vadThreshold === "number" && Number.isFinite(params.vadThreshold)) {
    overrides.vadThreshold = params.vadThreshold;
  }
  if (typeof params.silenceDurationMs === "number" && Number.isFinite(params.silenceDurationMs)) {
    overrides.silenceDurationMs = params.silenceDurationMs;
  }
  if (typeof params.prefixPaddingMs === "number" && Number.isFinite(params.prefixPaddingMs)) {
    overrides.prefixPaddingMs = params.prefixPaddingMs;
  }
  if (reasoningEffort) {
    overrides.reasoningEffort = reasoningEffort;
  }
  return Object.keys(overrides).length > 0 ? { ...providerConfig, ...overrides } : providerConfig;
}

export function resolveTalkRealtimeGatewayRelayLaunch(params: {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  cfg: OpenClawConfig;
  launchOptions: RealtimeVoiceLaunchOptions;
  consultRouting?: string;
}) {
  const forceAgentConsultOnFinalTranscript = params.consultRouting === "force-agent-consult";
  const providerConfig = withRealtimeBrowserOverrides(params.providerConfig, params.launchOptions);
  return {
    providerConfig,
    forceAgentConsultOnFinalTranscript,
    error: resolveInternalRealtimeVoiceGatewayRelayLaunchError({
      provider: params.provider,
      cfg: params.cfg,
      providerConfig,
      model: params.launchOptions.model,
      autoRespondToAudio: !forceAgentConsultOnFinalTranscript,
    }),
  };
}

function pickRealtimeVoiceLaunchOptions(
  params: RealtimeVoiceLaunchOptionInput,
): RealtimeVoiceLaunchOptions {
  const options: RealtimeVoiceLaunchOptions = {};
  const model = normalizeOptionalString(params.model);
  const voice = normalizeOptionalString(params.voice);
  const reasoningEffort = normalizeOptionalString(params.reasoningEffort);
  if (model) {
    options.model = model;
  }
  if (voice) {
    options.voice = voice;
  }
  if (typeof params.vadThreshold === "number" && Number.isFinite(params.vadThreshold)) {
    options.vadThreshold = params.vadThreshold;
  }
  if (typeof params.silenceDurationMs === "number" && Number.isFinite(params.silenceDurationMs)) {
    options.silenceDurationMs = params.silenceDurationMs;
  }
  if (typeof params.prefixPaddingMs === "number" && Number.isFinite(params.prefixPaddingMs)) {
    options.prefixPaddingMs = params.prefixPaddingMs;
  }
  if (reasoningEffort) {
    options.reasoningEffort = reasoningEffort;
  }
  return options;
}

export function isUnsupportedBrowserWebRtcSession(session: RealtimeVoiceBrowserSession): boolean {
  const provider = normalizeLowercaseStringOrEmpty(session.provider);
  const transport = (session as { transport?: string }).transport ?? "webrtc";
  // Google browser WebRTC sessions are exposed in provider types but not usable
  // through the current client-owned Talk flow.
  return provider === "google" && transport === "webrtc";
}
