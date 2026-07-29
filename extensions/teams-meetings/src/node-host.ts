import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import {
  DEFAULT_TEAMS_MEETINGS_AUDIO_INPUT_COMMAND,
  DEFAULT_TEAMS_MEETINGS_AUDIO_OUTPUT_COMMAND,
} from "./config.js";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./transports/teams-meetings-platform-adapter.js";

export const handleTeamsMeetingsNodeHostCommand =
  MeetingPlatformAdapter.createPluginNodeHostHandler({
    platform: TEAMS_MEETINGS_PLATFORM_ADAPTER,
    browserPageName: "Teams",
    meetingLabel: "Microsoft Teams meeting",
    defaultAudioInputCommand: DEFAULT_TEAMS_MEETINGS_AUDIO_INPUT_COMMAND,
    defaultAudioOutputCommand: DEFAULT_TEAMS_MEETINGS_AUDIO_OUTPUT_COMMAND,
    sharePrerequisiteDeadline: false,
  });
