// GPT-Live (OpenAI "quicksilver") uses browser or Gateway-owned WebRTC when
// the host owns delegation, and the Platform-key Frameless Bidi WebSocket elsewhere.

const OPENAI_GPT_LIVE_MODEL_PREFIX = "gpt-live";

export const OPENAI_GPT_LIVE_MODELS = ["gpt-live-1-codex", "gpt-live-1-boulder-alpha"] as const;

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
