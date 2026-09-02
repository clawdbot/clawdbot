import type { RealtimeVoiceTool } from "./provider-types.js";

export const REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME = "describe_view";

export const REALTIME_VOICE_DESCRIBE_VIEW_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
  description:
    "Capture the current browser camera frame when the caller asks what is visible or needs visual context.",
  parameters: {
    type: "object",
    properties: {},
  },
};
