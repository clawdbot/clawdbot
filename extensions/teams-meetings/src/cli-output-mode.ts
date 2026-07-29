import { createMeetingPluginCliMetadata } from "openclaw/plugin-sdk/meeting-runtime";

export const { descriptor: TEAMS_MEETINGS_CLI_DESCRIPTOR, entry: TEAMS_MEETINGS_CLI_METADATA } =
  createMeetingPluginCliMetadata({
    commandName: "teamsmeetings",
    description: "Join and manage Microsoft Teams meeting guests",
    id: "teams-meetings",
    name: "Microsoft Teams meetings",
  });
