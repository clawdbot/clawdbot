// GPT-Live (OpenAI "quicksilver") routing uses either the ChatGPT OAuth browser
// WebRTC path or the Platform API-key Frameless Bidi backend WebSocket path.

const OPENAI_GPT_LIVE_MODEL_PREFIX = "gpt-live";

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
