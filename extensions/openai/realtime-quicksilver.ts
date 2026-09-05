import type { RealtimeVoiceProviderCapabilities } from "openclaw/plugin-sdk/realtime-voice";
// Realtime voice uses browser or Gateway-owned WebRTC when the host owns delegation,
// and the Platform-key direct WebSocket transport elsewhere.

const OPENAI_GPT_LIVE_MODEL_PREFIX = "gpt-live";

// Realtime V3 currently accepts only this voice family across both transports.
const OPENAI_GPT_LIVE_VOICES = ["marin", "cedar"] as const;
export type OpenAIGptLiveVoice = (typeof OPENAI_GPT_LIVE_VOICES)[number];
export const OPENAI_GPT_LIVE_DEFAULT_VOICE: OpenAIGptLiveVoice = "marin";

export function resolveOpenAIQuicksilverVoice(value: unknown): OpenAIGptLiveVoice {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return (
      OPENAI_GPT_LIVE_VOICES.find((voice) => voice === normalized) ?? OPENAI_GPT_LIVE_DEFAULT_VOICE
    );
  }
  return OPENAI_GPT_LIVE_DEFAULT_VOICE;
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
  voices: OPENAI_GPT_LIVE_VOICES,
  voiceSelectionPolicy: "allowlist-default" as const,
} satisfies Partial<RealtimeVoiceProviderCapabilities> & {
  handlesAgentConsult: true;
  voices: readonly string[];
  voiceSelectionPolicy: "allowlist-default";
};
