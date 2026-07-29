import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";

export const { descriptor: ZOOM_MEETINGS_CLI_DESCRIPTOR, entry: ZOOM_MEETINGS_CLI_METADATA } =
  MeetingPlatformAdapter.createCliMetadata({
    commandName: "zoommeetings",
    description: "Join and manage Zoom meeting guests",
    id: "zoom-meetings",
    name: "Zoom meetings",
  });
