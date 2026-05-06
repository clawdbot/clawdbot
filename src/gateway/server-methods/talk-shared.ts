import type { OpenClawConfig } from "../../config/types.js";
import { listRealtimeTranscriptionProviders } from "../../realtime-transcription/provider-registry.js";
import type { RealtimeTranscriptionProviderConfig } from "../../realtime-transcription/provider-types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../talk/agent-consult-tool.js";
import type {
  RealtimeVoiceBrowserSession,
  RealtimeVoiceProviderConfig,
} from "../../talk/provider-types.js";
import type { TalkEvent } from "../../talk/talk-events.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { ErrorCodes } from "../protocol/index.js";
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

export function buildTalkRealtimeConfig(config: OpenClawConfig, requestedProvider?: string) {
  const voiceCallRealtime = getVoiceCallRealtimeConfig(config);
  const talkRealtime = getRecord(config.talk?.realtime);
  const talkRealtimeProviderConfigs = talkRealtime?.providers as
    | Record<string, RealtimeVoiceProviderConfig>
    | undefined;
  const provider =
    normalizeOptionalString(requestedProvider) ??
    normalizeOptionalString(talkRealtime?.provider) ??
    voiceCallRealtime.provider;
  return {
    provider,
    providers: {
      ...voiceCallRealtime.providers,
      ...talkRealtimeProviderConfigs,
    },
    model: normalizeOptionalString(talkRealtime?.model),
    voice: normalizeOptionalString(talkRealtime?.voice),
    mode: normalizeOptionalLowercaseString(talkRealtime?.mode),
    transport: normalizeOptionalLowercaseString(talkRealtime?.transport),
    brain: normalizeOptionalLowercaseString(talkRealtime?.brain),
  };
}

export function buildTalkTranscriptionConfig(config: OpenClawConfig, requestedProvider?: string) {
  const streamingConfig = getVoiceCallStreamingConfig(config);
  return {
    provider: normalizeOptionalString(requestedProvider) ?? streamingConfig.provider,
    providers: streamingConfig.providers ?? {},
  };
}

function getRealtimeTranscriptionProviderConfig(params: {
  providerConfigs: Record<string, RealtimeTranscriptionProviderConfig>;
  provider: { id: string; aliases?: readonly string[] };
  configuredProviderId?: string;
}): RealtimeTranscriptionProviderConfig {
  const candidates = [
    normalizeOptionalString(params.configuredProviderId),
    params.provider.id,
    ...(params.provider.aliases ?? []),
  ].filter((key): key is string => Boolean(key));
  const configuredKeys = Object.keys(params.providerConfigs);
  for (const candidate of candidates) {
    if (Object.hasOwn(params.providerConfigs, candidate)) {
      return params.providerConfigs[candidate] ?? {};
    }
    const normalizedCandidate = normalizeOptionalLowercaseString(candidate);
    const matchingKey = configuredKeys.find(
      (key) => normalizeOptionalLowercaseString(key) === normalizedCandidate,
    );
    if (matchingKey) {
      return params.providerConfigs[matchingKey] ?? {};
    }
  }
  return {};
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
    const rawConfig = getRealtimeTranscriptionProviderConfig({
      providerConfigs: params.providerConfigs,
      provider,
      configuredProviderId: params.configuredProviderId,
    });
    const providerConfig = provider.resolveConfig?.({ cfg: params.config, rawConfig }) ?? rawConfig;
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

export function buildRealtimeInstructions(): string {
  return `You are OpenClaw's realtime voice interface. Keep spoken replies concise. If the user asks for code, repository state, tools, files, current OpenClaw context, or deeper reasoning, call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} and then summarize the result naturally.`;
}

export function withRealtimeBrowserOverrides(
  providerConfig: RealtimeVoiceProviderConfig,
  params: { model?: string; voice?: string },
): RealtimeVoiceProviderConfig {
  const overrides: RealtimeVoiceProviderConfig = {};
  const model = normalizeOptionalString(params.model);
  const voice = normalizeOptionalString(params.voice);
  if (model) {
    overrides.model = model;
  }
  if (voice) {
    overrides.voice = voice;
  }
  return Object.keys(overrides).length > 0 ? { ...providerConfig, ...overrides } : providerConfig;
}

export function isUnsupportedBrowserWebRtcSession(session: RealtimeVoiceBrowserSession): boolean {
  const provider = normalizeLowercaseStringOrEmpty(session.provider);
  const transport = (session as { transport?: string }).transport ?? "webrtc";
  return provider === "google" && transport === "webrtc";
}
