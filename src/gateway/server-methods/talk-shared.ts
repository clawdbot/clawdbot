import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import {
  getVoiceProviderConfig,
  providerMatchesId,
  resolveSupportedVoiceModelRefs,
  type VoiceModelProvider,
} from "../../../packages/speech-core/voice-models.js";
import type { OpenClawConfig } from "../../config/types.js";
import { listRealtimeTranscriptionProviders } from "../../realtime-transcription/provider-registry.js";
import type { RealtimeTranscriptionProviderConfig } from "../../realtime-transcription/provider-types.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME } from "../../talk/agent-run-control-shared.js";
import { listRealtimeVoiceProviders } from "../../talk/provider-registry.js";
import type {
  RealtimeVoiceBrowserSession,
  RealtimeVoiceProviderConfig,
} from "../../talk/provider-types.js";
import type { TalkEvent } from "../../talk/talk-events.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import type { TalkHandoffTurnResult } from "../talk-handoff.js";
import { asRecord } from "./record-shared.js";

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

type TalkHandoffFailureReason = Extract<TalkHandoffTurnResult, { ok: false }>["reason"];

export function talkHandoffErrorCode(reason: TalkHandoffFailureReason) {
  return reason === "invalid_token" || reason === "no_active_turn" || reason === "stale_turn"
    ? ErrorCodes.INVALID_REQUEST
    : ErrorCodes.UNAVAILABLE;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value) ?? undefined;
}

function singleRecordKey(record: Record<string, unknown> | undefined): string | undefined {
  const keys = record ? Object.keys(record) : [];
  return keys.length === 1 ? keys[0] : undefined;
}

function getVoiceCallRealtimeConfig(config: OpenClawConfig): {
  provider?: string;
  providers?: Record<string, RealtimeVoiceProviderConfig>;
} {
  const plugins = getRecord(config.plugins);
  const entries = getRecord(plugins?.entries);
  const voiceCall = getRecord(entries?.["voice-call"]);
  const pluginConfig = getRecord(voiceCall?.config);
  const realtime = getRecord(pluginConfig?.realtime);
  const providersRaw = getRecord(realtime?.providers);
  const providers: Record<string, RealtimeVoiceProviderConfig> = {};
  if (providersRaw) {
    for (const [providerId, providerConfig] of Object.entries(providersRaw)) {
      const record = getRecord(providerConfig);
      if (record) {
        providers[providerId] = record;
      }
    }
  }
  return {
    provider: normalizeOptionalString(realtime?.provider),
    providers: Object.keys(providers).length > 0 ? providers : undefined,
  };
}

export function getVoiceCallStreamingConfig(config: OpenClawConfig): {
  provider?: string;
  providers?: Record<string, RealtimeTranscriptionProviderConfig>;
} {
  const plugins = getRecord(config.plugins);
  const entries = getRecord(plugins?.entries);
  const voiceCall = getRecord(entries?.["voice-call"]);
  const pluginConfig = getRecord(voiceCall?.config);
  const streaming = getRecord(pluginConfig?.streaming);
  const providersRaw = getRecord(streaming?.providers);
  const providers: Record<string, RealtimeTranscriptionProviderConfig> = {};
  if (providersRaw) {
    for (const [providerId, providerConfig] of Object.entries(providersRaw)) {
      const record = getRecord(providerConfig);
      if (record) {
        providers[providerId] = record;
      }
    }
  }
  return {
    provider: normalizeOptionalString(streaming?.provider),
    providers: Object.keys(providers).length > 0 ? providers : undefined,
  };
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
      const rawConfigWithModel =
        rawConfig.model === undefined ? { ...rawConfig, model: ref.model } : rawConfig;
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

export function buildTalkRealtimeConfig(config: OpenClawConfig, requestedProvider?: string) {
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
  const providerConfigs = {
    ...voiceCallRealtime.providers,
    ...talkRealtimeProviderConfigs,
  };
  const voiceModelDefault = resolveConfiguredVoiceModelDefaultRef({
    config,
    provider: selectedProvider,
    providerConfigs,
    providers: listRealtimeVoiceProviders(config),
  });
  const provider = selectedProvider ?? voiceModelDefault?.provider;
  const model = normalizeOptionalString(talkRealtime?.model) ?? voiceModelDefault?.model;
  return {
    provider,
    providers: providerConfigs,
    model,
    voice:
      normalizeOptionalString(talkRealtime?.speakerVoice) ??
      normalizeOptionalString(talkRealtime?.speakerVoiceId) ??
      normalizeOptionalString(talkRealtime?.voice),
    instructions: normalizeOptionalString(talkRealtime?.instructions),
    mode: normalizeOptionalLowercaseString(talkRealtime?.mode),
    transport: normalizeOptionalLowercaseString(talkRealtime?.transport),
    brain: normalizeOptionalLowercaseString(talkRealtime?.brain),
    consultRouting: normalizeOptionalLowercaseString(talkRealtime?.consultRouting),
  };
}

export function buildTalkTranscriptionConfig(config: OpenClawConfig, requestedProvider?: string) {
  const streamingConfig = getVoiceCallStreamingConfig(config);
  const provider = normalizeOptionalString(requestedProvider) ?? streamingConfig.provider;
  const providerConfigs = streamingConfig.providers ?? {};
  const voiceModelDefault = resolveConfiguredVoiceModelDefaultRef({
    config,
    provider,
    providerConfigs,
    providers: listRealtimeTranscriptionProviders(config),
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
  defaultModel?: string;
}) {
  const providers = listRealtimeTranscriptionProviders(params.config);
  const normalizedConfigured = normalizeOptionalLowercaseString(params.configuredProviderId);
  const orderedProviders = normalizedConfigured
    ? providers.filter(
        (provider) =>
          normalizeOptionalLowercaseString(provider.id) === normalizedConfigured ||
          (provider.aliases ?? []).some(
            (alias) => normalizeOptionalLowercaseString(alias) === normalizedConfigured,
          ),
      )
    : providers.toSorted((a, b) => (a.autoSelectOrder ?? 1000) - (b.autoSelectOrder ?? 1000));
  for (const provider of orderedProviders) {
    const rawConfig = getVoiceProviderConfig({
      providerConfigs: params.providerConfigs,
      provider,
      configuredProviderId: params.configuredProviderId,
    });
    const rawConfigWithModel =
      params.defaultModel && rawConfig.model === undefined
        ? { ...rawConfig, model: params.defaultModel }
        : rawConfig;
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
  return {
    ...options,
    ...pickRealtimeVoiceLaunchOptions(params.requested),
  };
}

export function withRealtimeBrowserOverrides(
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
  return provider === "google" && transport === "webrtc";
}
