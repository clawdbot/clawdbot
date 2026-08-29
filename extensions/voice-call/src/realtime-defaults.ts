// Voice Call plugin module implements realtime defaults behavior.
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "openclaw/plugin-sdk/realtime-voice";
import { normalizeWebhookPath } from "openclaw/plugin-sdk/webhook-ingress";
import { REALTIME_VOICE_END_CALL_TOOL_NAME } from "./realtime-call-control.js";

// Default realtime instructions for the voice-call plugin's phone interface.

/** Baseline instructions that keep realtime calls brief and route deep work to agent consult. */
export const DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS = `You are OpenClaw's phone-call realtime voice interface. Keep spoken replies brief and natural. When a question needs deeper reasoning, current information, or tools, call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} before answering. When the caller asks to end the call, speak any final words first, then call ${REALTIME_VOICE_END_CALL_TOOL_NAME}; it ends the call immediately and nothing after it will be spoken.`;

export function resolveDefaultRealtimeStreamPath(servePath: string): string {
  const normalized = normalizeWebhookPath(servePath);
  if (normalized.endsWith("/webhook")) {
    return `${normalized.slice(0, -"/webhook".length)}/stream/realtime`;
  }
  return normalized === "/" ? "/voice/stream/realtime" : `${normalized}/stream/realtime`;
}
