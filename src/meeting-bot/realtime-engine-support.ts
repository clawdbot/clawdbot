import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
} from "../plugins/types.js";
import {
  getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders,
} from "../realtime-transcription/provider-registry.js";
import type { RealtimeTranscriptionProviderConfig } from "../realtime-transcription/provider-types.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../talk/provider-resolver.js";
import type { RealtimeVoiceProviderConfig } from "../talk/provider-types.js";
import { truncateUtf16Safe } from "../utils.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";

type MeetingRealtimeProviderSelectionConfig = {
  realtime: {
    provider?: string;
    transcriptionProvider?: string;
    voiceProvider?: string;
    model?: string;
    providers: Record<string, Record<string, unknown>>;
  };
};

type ResolvedRealtimeProvider = {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
};

type ResolvedRealtimeTranscriptionProvider = {
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
};

export function meetingOutputBytesPerMs(audioFormat: MeetingRealtimeAudioFormat): number {
  return audioFormat === "g711-ulaw-8khz" ? 8 : 48;
}

export function resolveMeetingRealtimeProvider(params: {
  config: MeetingRealtimeProviderSelectionConfig;
  fullConfig: OpenClawConfig;
  providers?: RealtimeVoiceProviderPlugin[];
}): ResolvedRealtimeProvider {
  const providerId = params.config.realtime.voiceProvider ?? params.config.realtime.provider;
  return resolveConfiguredRealtimeVoiceProvider({
    configuredProviderId: providerId,
    providerConfigs: params.config.realtime.providers,
    cfg: params.fullConfig,
    providers: params.providers,
    defaultModel: params.config.realtime.model,
    noRegisteredProviderMessage: "No configured realtime voice provider registered",
  });
}

export function resolveMeetingRealtimeTranscriptionProvider(params: {
  config: MeetingRealtimeProviderSelectionConfig;
  fullConfig: OpenClawConfig;
  providers?: RealtimeTranscriptionProviderPlugin[];
}): ResolvedRealtimeTranscriptionProvider {
  const providers = params.providers ?? listRealtimeTranscriptionProviders(params.fullConfig);
  if (providers.length === 0) {
    throw new Error("No configured realtime transcription provider registered");
  }
  const providerId =
    params.config.realtime.transcriptionProvider ?? params.config.realtime.provider;
  const configuredProvider = providerId
    ? (params.providers?.find(
        (entry) => entry.id === providerId || entry.aliases?.includes(providerId),
      ) ?? getRealtimeTranscriptionProvider(providerId, params.fullConfig))
    : undefined;
  const provider = configuredProvider ?? providers[0];
  if (!provider) {
    throw new Error("No configured realtime transcription provider registered");
  }
  const rawConfig = providerId
    ? (params.config.realtime.providers[providerId] ??
      params.config.realtime.providers[provider.id] ??
      {})
    : (params.config.realtime.providers[provider.id] ?? {});
  const providerConfig = provider.resolveConfig
    ? provider.resolveConfig({ cfg: params.fullConfig, rawConfig })
    : rawConfig;
  if (!provider.isConfigured({ cfg: params.fullConfig, providerConfig })) {
    throw new Error(`Realtime transcription provider "${provider.id}" is not configured`);
  }
  return { provider, providerConfig };
}

export function buildMeetingSpeakExactUserMessage(text: string): string {
  return [
    "Speak this exact OpenClaw answer to the meeting, without adding, removing, or rephrasing words.",
    `Answer: ${JSON.stringify(text)}`,
  ].join("\n");
}

function readLogString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatLogValue(value: string | undefined): string {
  const normalized = value ? truncateUtf16Safe(value.replace(/\s+/g, "_"), 180) : undefined;
  return normalized || "unknown";
}

function resolveProviderModelForLog(params: {
  provider: { defaultModel?: string };
  providerConfig: RealtimeVoiceProviderConfig | RealtimeTranscriptionProviderConfig;
  fallbackModel?: string;
}): string {
  return (
    readLogString(params.providerConfig.model) ??
    readLogString(params.providerConfig.modelId) ??
    readLogString(params.fallbackModel) ??
    readLogString(params.provider.defaultModel) ??
    "provider-default"
  );
}

export function formatMeetingRealtimeVoiceModelLog(params: {
  logScope: string;
  strategy: string;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  fallbackModel?: string;
  audioFormat: MeetingRealtimeAudioFormat;
}): string {
  return [
    `${params.logScope} realtime voice bridge starting: strategy=${formatLogValue(params.strategy)}`,
    `provider=${formatLogValue(params.provider.id)}`,
    `model=${formatLogValue(
      resolveProviderModelForLog({
        provider: params.provider,
        providerConfig: params.providerConfig,
        fallbackModel: params.fallbackModel,
      }),
    )}`,
    `audioFormat=${formatLogValue(params.audioFormat)}`,
  ].join(" ");
}

export function formatMeetingAgentAudioModelLog(params: {
  logScope: string;
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
  audioFormat: MeetingRealtimeAudioFormat;
}): string {
  return [
    `${params.logScope} agent audio bridge starting: transcriptionProvider=${formatLogValue(
      params.provider.id,
    )}`,
    `transcriptionModel=${formatLogValue(
      resolveProviderModelForLog({
        provider: params.provider,
        providerConfig: params.providerConfig,
      }),
    )}`,
    "tts=telephony",
    `audioFormat=${formatLogValue(params.audioFormat)}`,
  ].join(" ");
}

type MeetingTtsResultLogFields = {
  provider?: string;
  providerModel?: string;
  providerVoice?: string;
  outputFormat?: string;
  sampleRate?: number;
  fallbackFrom?: string;
};

export function formatMeetingAgentTtsResultLog(
  logScope: string,
  prefix: string,
  result: MeetingTtsResultLogFields,
): string {
  return [
    `${logScope} ${prefix} TTS: provider=${formatLogValue(result.provider)}`,
    `model=${formatLogValue(result.providerModel)}`,
    `voice=${formatLogValue(result.providerVoice)}`,
    `outputFormat=${formatLogValue(result.outputFormat)}`,
    `sampleRate=${result.sampleRate ?? "unknown"}`,
    ...(result.fallbackFrom ? [`fallbackFrom=${formatLogValue(result.fallbackFrom)}`] : []),
  ].join(" ");
}

export function formatMeetingTranscriptSummaryLog(
  logScope: string,
  prefix: string,
  text: string,
): string {
  return `${logScope} ${prefix}: chars=${text.length}`;
}

export function normalizeMeetingTtsPromptText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sayExactly = trimmed.match(/^say exactly:\s*(?<text>.+)$/is)?.groups?.text?.trim();
  if (sayExactly) {
    return sayExactly.replace(/^["']|["']$/g, "").trim() || trimmed;
  }
  return trimmed;
}
