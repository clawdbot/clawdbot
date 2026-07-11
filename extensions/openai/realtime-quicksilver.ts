// GPT-Live (OpenAI "quicksilver" session type) gating for realtime voice.
//
// GPT-Live models (gpt-live-1, gpt-live-1-mini) are full-duplex quicksilver
// sessions: WebRTC-only (the API rejects websocket session creation with
// "Quicksilver sessions require WebRTC", probed 2026-07-11), no client
// turn_detection or tools, and agent delegation happens via
// conversation.handoff.* events instead of GA function-call events. The Talk
// browser client only speaks the GA Realtime protocol today, so routing
// GPT-Live into it would connect audio while agent consult silently never
// fires. Both transports fail closed with guidance until the handoff protocol
// is implemented (wire shape reference: openai/codex codex-rs realtime v1);
// the API is also org-gated until OpenAI opens GPT-Live access.

const OPENAI_GPT_LIVE_MODEL_PREFIX = "gpt-live";

export const OPENAI_GPT_LIVE_BRIDGE_UNSUPPORTED_MESSAGE =
  "GPT-Live models are not supported on the realtime WebSocket bridge: OpenAI requires WebRTC for quicksilver sessions. Set a gpt-realtime model for this transport.";

export const OPENAI_GPT_LIVE_BROWSER_SESSION_UNSUPPORTED_MESSAGE =
  "GPT-Live models are not supported for Talk browser sessions yet: quicksilver sessions delegate through conversation.handoff events that the Talk client does not implement. Set a gpt-realtime model until GPT-Live support lands.";

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
