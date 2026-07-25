import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import {
  DEFAULT_ZOOM_MEETINGS_AUDIO_INPUT_COMMAND,
  DEFAULT_ZOOM_MEETINGS_AUDIO_OUTPUT_COMMAND,
} from "./config.js";
import {
  ZOOM_MEETINGS_SYSTEM_PROFILER_COMMAND,
  outputMentionsBlackHole2ch,
} from "./transports/chrome-audio-device.js";
import { ZOOM_MEETINGS_PLATFORM_ADAPTER } from "./transports/zoom-meetings-platform-adapter.js";
import { ZOOM_MEETINGS_NODE_COMMAND } from "./transports/zoom-meetings-platform-constants.js";

export const handleZoomMeetingsNodeHostCommand = MeetingPlatformAdapter.createNodeHostHandler({
  commandName: ZOOM_MEETINGS_NODE_COMMAND,
  displayName: "Zoom meetings",
  meetingLabel: "Zoom meeting",
  browserLabel: "Zoom meeting",
  bridgeIdPrefix: "zoom_meeting_node_",
  defaultAudioInputCommand: DEFAULT_ZOOM_MEETINGS_AUDIO_INPUT_COMMAND,
  defaultAudioOutputCommand: DEFAULT_ZOOM_MEETINGS_AUDIO_OUTPUT_COMMAND,
  talkBackModes: new Set(["agent", "bidi"]),
  agentMode: "agent",
  normalizeUrl: (url) => ZOOM_MEETINGS_PLATFORM_ADAPTER.urls.validateAndNormalize(url),
  normalizeMeetingKey: (url) => ZOOM_MEETINGS_PLATFORM_ADAPTER.urls.normalizeForReuse(url),
  outputMentionsAudioDevice: outputMentionsBlackHole2ch,
  sharePrerequisiteDeadline: true,
  systemProfilerCommand: ZOOM_MEETINGS_SYSTEM_PROFILER_COMMAND,
  browser: {
    application: "Google Chrome",
    buildProfileArgs: (profile) => ["--args", `--profile-directory=${profile}`],
    openedStatus: "chrome-opened",
    openedNotes: [
      "Zoom page control is handled by OpenClaw browser automation when using chrome-node.",
    ],
  },
});
