import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";

export const { descriptor: TEAMS_MEETINGS_CLI_DESCRIPTOR, entry: TEAMS_MEETINGS_CLI_METADATA } =
  MeetingPlatformAdapter.createCliMetadata({
    commandName: "teamsmeetings",
    description: "Join and manage Microsoft Teams meeting guests",
    id: "teams-meetings",
    name: "Microsoft Teams meetings",
  });
