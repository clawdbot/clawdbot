import { createMeetingPluginNodeInvokePolicy } from "openclaw/plugin-sdk/meeting-runtime";
import type { TeamsMeetingsConfig } from "./config.js";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./transports/teams-meetings-platform-adapter.js";

export function createTeamsMeetingsNodeInvokePolicy(config: TeamsMeetingsConfig) {
  return createMeetingPluginNodeInvokePolicy(config, {
    deniedCode: "TEAMS_MEETINGS_NODE_POLICY_DENIED",
    platform: TEAMS_MEETINGS_PLATFORM_ADAPTER,
  });
}
