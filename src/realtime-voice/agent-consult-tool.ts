import type { RealtimeVoiceTool } from "./provider-types.js";

export const REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME = "openclaw_agent_consult";

export const REALTIME_VOICE_AGENT_CONSULT_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  description:
    "Ask the full OpenClaw agent for deeper reasoning, current information, or tool-backed help before speaking.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The concrete question or task the user asked.",
      },
      context: {
        type: "string",
        description: "Optional relevant context or transcript summary.",
      },
      responseStyle: {
        type: "string",
        description: "Optional style hint for the spoken answer.",
      },
    },
    required: ["question"],
  },
};
