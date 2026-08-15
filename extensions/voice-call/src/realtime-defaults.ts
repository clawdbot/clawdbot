// Voice Call plugin module implements realtime defaults behavior.
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "openclaw/plugin-sdk/realtime-voice";

// Default realtime instructions for the voice-call plugin's phone interface.

/** Baseline instructions that keep realtime calls brief and route deep work to agent consult. */
export const DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS = `You are OpenClaw's phone-call realtime voice interface. Keep spoken replies brief and natural. When a question needs deeper reasoning, current information, or tools, call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} before answering.`;
