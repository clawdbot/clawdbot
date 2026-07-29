import { createMeetingPluginNodeHostHandler } from "openclaw/plugin-sdk/meeting-runtime";
import {
  DEFAULT_ZOOM_MEETINGS_AUDIO_INPUT_COMMAND,
  DEFAULT_ZOOM_MEETINGS_AUDIO_OUTPUT_COMMAND,
} from "./config.js";
import { ZOOM_MEETINGS_PLATFORM_ADAPTER } from "./transports/zoom-meetings-platform-adapter.js";

export const handleZoomMeetingsNodeHostCommand = createMeetingPluginNodeHostHandler({
  platform: ZOOM_MEETINGS_PLATFORM_ADAPTER,
  browserPageName: "Zoom",
  meetingLabel: "Zoom meeting",
  defaultAudioInputCommand: DEFAULT_ZOOM_MEETINGS_AUDIO_INPUT_COMMAND,
  defaultAudioOutputCommand: DEFAULT_ZOOM_MEETINGS_AUDIO_OUTPUT_COMMAND,
  sharePrerequisiteDeadline: true,
});
