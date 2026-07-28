import { createMeetingBrowserNodeInvokePolicy } from "openclaw/plugin-sdk/meeting-runtime";
import type { TeamsMeetingsConfig } from "./config.js";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./transports/teams-meetings-platform-adapter.js";
import { TEAMS_MEETINGS_NODE_COMMAND } from "./transports/teams-meetings-platform-constants.js";

export function createTeamsMeetingsNodeInvokePolicy(config: TeamsMeetingsConfig) {
  return createMeetingBrowserNodeInvokePolicy({
    commandName: TEAMS_MEETINGS_NODE_COMMAND,
    displayName: "Microsoft Teams meetings",
    deniedCode: "TEAMS_MEETINGS_NODE_POLICY_DENIED",
    supportedModes: new Set(["agent", "bidi", "transcribe"]),
    normalizeUrl: (url) => TEAMS_MEETINGS_PLATFORM_ADAPTER.urls.validateAndNormalize(url),
    useConfiguredSetupCommands: true,
    start: config.chrome,
  });
}
