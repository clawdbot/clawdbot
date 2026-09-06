import type { RealtimeVoiceProviderCapabilities } from "openclaw/plugin-sdk/realtime-voice";
// Realtime voice uses browser or Gateway-owned WebRTC when the host owns delegation,
// and the Platform-key direct WebSocket transport elsewhere.

const OPENAI_GPT_LIVE_MODEL_PREFIX = "gpt-live";

export const OPENAI_GPT_LIVE_MODELS = ["gpt-live-1-codex"] as const;
export const OPENAI_GPT_LIVE_VOICES = [
  "arbor",
  "breeze",
  "cove",
  "ember",
  "juniper",
  "maple",
  "sol",
  "spruce",
  "vale",
] as const;
const OPENAI_GPT_LIVE_UNLISTED_VOICES = ["marin", "cedar"] as const;
export type OpenAIGptLiveVoice =
  | (typeof OPENAI_GPT_LIVE_VOICES)[number]
  | (typeof OPENAI_GPT_LIVE_UNLISTED_VOICES)[number];

export function isSupportedOpenAIGptLiveModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  const normalized = model.trim().toLowerCase();
  return OPENAI_GPT_LIVE_MODELS.includes(normalized as (typeof OPENAI_GPT_LIVE_MODELS)[number]);
}

export function resolveOpenAIQuicksilverVoice(model: string, value: unknown): OpenAIGptLiveVoice {
  const voices = isSupportedOpenAIGptLiveModel(model)
    ? OPENAI_GPT_LIVE_VOICES
    : OPENAI_GPT_LIVE_UNLISTED_VOICES;
  const defaultVoice = isSupportedOpenAIGptLiveModel(model) ? "cove" : "marin";
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return voices.find((voice) => voice === normalized) ?? defaultVoice;
  }
  return defaultVoice;
}

export function isOpenAIGptLiveModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  const normalized = model.trim().toLowerCase();
  return (
    normalized === OPENAI_GPT_LIVE_MODEL_PREFIX ||
    normalized.startsWith(`${OPENAI_GPT_LIVE_MODEL_PREFIX}-`)
  );
}

export const OPENAI_QUICKSILVER_CAPABILITIES = {
  transports: ["webrtc" as const, "gateway-relay" as const],
  handlesAgentConsult: true as const,
  supportsToolCalls: false,
  supportsVideoFrames: false,
} satisfies Partial<RealtimeVoiceProviderCapabilities> & { handlesAgentConsult: true };

export function resolveOpenAIQuicksilverVoiceCapabilities(model: string): {
  voices: readonly string[];
  voiceSelectionPolicy: "allowlist-default";
} {
  return {
    voices: isSupportedOpenAIGptLiveModel(model)
      ? OPENAI_GPT_LIVE_VOICES
      : OPENAI_GPT_LIVE_UNLISTED_VOICES,
    voiceSelectionPolicy: "allowlist-default",
  };
}
