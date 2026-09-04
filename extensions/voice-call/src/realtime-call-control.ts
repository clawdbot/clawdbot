// Voice Call plugin module defines provider-facing realtime call controls.
import {
  resolveRealtimeVoiceAgentConsultTools,
  type RealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";

/** Stable provider-facing tool name for ending the current phone call. */
export const REALTIME_VOICE_END_CALL_TOOL_NAME = "openclaw_end_call";

/** Closure-bound end-call control exposed on every realtime phone call. */
const REALTIME_VOICE_END_CALL_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: REALTIME_VOICE_END_CALL_TOOL_NAME,
  description:
    "End the current phone call after already-generated speech finishes playing. Speak any final words to the caller before invoking this tool because no new reply will be generated afterward.",
  parameters: {
    type: "object",
    properties: {},
  },
};

/** Merge built-in call controls with consult and configured realtime tools. */
export function resolveVoiceCallRealtimeTools(
  policy: RealtimeVoiceAgentConsultToolPolicy,
  customTools: RealtimeVoiceTool[] = [],
): RealtimeVoiceTool[] {
  const tools = resolveRealtimeVoiceAgentConsultTools(policy, customTools).filter(
    (tool) => tool.name !== REALTIME_VOICE_END_CALL_TOOL_NAME,
  );
  return [REALTIME_VOICE_END_CALL_TOOL, ...tools];
}
