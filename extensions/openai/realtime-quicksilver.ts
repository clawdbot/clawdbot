// GPT-Live (OpenAI "quicksilver") browser Talk routing uses the live-proven
// ChatGPT OAuth WebRTC and sideband path. Relay and backend WebSocket bridges
// stay unsupported; Platform API-key access remains waitlist-gated.

const OPENAI_GPT_LIVE_MODEL_PREFIX = "gpt-live";

export const OPENAI_GPT_LIVE_BRIDGE_UNSUPPORTED_MESSAGE =
  "GPT-Live models are not supported on the realtime WebSocket bridge: OpenAI requires WebRTC for quicksilver sessions. Set a gpt-realtime model for this transport.";

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
