import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import {
  DEFAULT_TEAMS_MEETINGS_AUDIO_INPUT_COMMAND,
  DEFAULT_TEAMS_MEETINGS_AUDIO_OUTPUT_COMMAND,
} from "./config.js";
import {
  TEAMS_MEETINGS_SYSTEM_PROFILER_COMMAND,
  outputMentionsBlackHole2ch,
} from "./transports/chrome-audio-device.js";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./transports/teams-meetings-platform-adapter.js";
import { TEAMS_MEETINGS_NODE_COMMAND } from "./transports/teams-meetings-platform-constants.js";

export const handleTeamsMeetingsNodeHostCommand = MeetingPlatformAdapter.createNodeHostHandler({
  commandName: TEAMS_MEETINGS_NODE_COMMAND,
  displayName: "Microsoft Teams meetings",
  meetingLabel: "Microsoft Teams meeting",
  browserLabel: "Teams meeting",
  bridgeIdPrefix: "teams_meeting_node_",
  defaultAudioInputCommand: DEFAULT_TEAMS_MEETINGS_AUDIO_INPUT_COMMAND,
  defaultAudioOutputCommand: DEFAULT_TEAMS_MEETINGS_AUDIO_OUTPUT_COMMAND,
  talkBackModes: new Set(["agent", "bidi"]),
  agentMode: "agent",
  normalizeUrl: (url) => TEAMS_MEETINGS_PLATFORM_ADAPTER.urls.validateAndNormalize(url),
  normalizeMeetingKey: (url) => TEAMS_MEETINGS_PLATFORM_ADAPTER.urls.normalizeForReuse(url),
  outputMentionsAudioDevice: outputMentionsBlackHole2ch,
  sharePrerequisiteDeadline: false,
  systemProfilerCommand: TEAMS_MEETINGS_SYSTEM_PROFILER_COMMAND,
  browser: {
    application: "Google Chrome",
    buildProfileArgs: (profile) => ["--args", `--profile-directory=${profile}`],
    openedStatus: "chrome-opened",
    openedNotes: [
      "Teams page control is handled by OpenClaw browser automation when using chrome-node.",
    ],
  },
});
