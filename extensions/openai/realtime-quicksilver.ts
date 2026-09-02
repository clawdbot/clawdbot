// GPT-Live (OpenAI "quicksilver") uses browser or Gateway-owned WebRTC when
// the host owns delegation, and the Platform-key Frameless Bidi WebSocket elsewhere.

const OPENAI_GPT_LIVE_MODEL_PREFIX = "gpt-live";

export const OPENAI_GPT_LIVE_MODELS = ["gpt-live-1-codex"] as const;
// Codex realtime V3 uses the V1 voice family for WebRTC and direct WebSocket sessions.
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
export type OpenAIGptLiveVoice = (typeof OPENAI_GPT_LIVE_VOICES)[number];
export const OPENAI_GPT_LIVE_DEFAULT_VOICE: OpenAIGptLiveVoice = "cove";

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

export function isSupportedOpenAIGptLiveModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  const normalized = model.trim().toLowerCase();
  return OPENAI_GPT_LIVE_MODELS.includes(normalized as (typeof OPENAI_GPT_LIVE_MODELS)[number]);
}
