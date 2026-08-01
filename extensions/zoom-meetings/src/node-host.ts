import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { zoomMeetingsConfig } from "./config.js";
import { ZOOM_MEETINGS_PLATFORM_ADAPTER } from "./transports/zoom-meetings-platform-adapter.js";

export const handleZoomMeetingsNodeHostCommand = MeetingPlatformAdapter.createPluginNodeHostHandler(
  {
    platform: ZOOM_MEETINGS_PLATFORM_ADAPTER,
    browserPageName: "Zoom",
    meetingLabel: "Zoom meeting",
    defaultAudioInputCommand: zoomMeetingsConfig.defaultAudioInputCommand,
    defaultAudioOutputCommand: zoomMeetingsConfig.defaultAudioOutputCommand,
    sharePrerequisiteDeadline: true,
  },
);
