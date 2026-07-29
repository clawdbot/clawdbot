import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { teamsMeetingsConfig } from "./config.js";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./transports/teams-meetings-platform-adapter.js";

export const handleTeamsMeetingsNodeHostCommand =
  MeetingPlatformAdapter.createPluginNodeHostHandler({
    platform: TEAMS_MEETINGS_PLATFORM_ADAPTER,
    browserPageName: "Teams",
    meetingLabel: "Microsoft Teams meeting",
    defaultAudioInputCommand: teamsMeetingsConfig.defaultAudioInputCommand,
    defaultAudioOutputCommand: teamsMeetingsConfig.defaultAudioOutputCommand,
    sharePrerequisiteDeadline: false,
  });
