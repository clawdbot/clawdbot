import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { TeamsMeetingsConfig, TeamsMeetingsMode } from "./config.js";
import { assertTeamsMeetingsAudioAvailable } from "./transports/chrome.js";
import { TEAMS_MEETINGS_BROWSER_NODE_ADAPTER } from "./transports/teams-meetings-platform-constants.js";

export const getTeamsMeetingsSetupStatus = MeetingPlatformAdapter.createRuntimeSetup<
  TeamsMeetingsConfig,
  TeamsMeetingsMode
>({
  assertAudioDeviceAvailable: assertTeamsMeetingsAudioAvailable,
  captionsMessage: (mode) =>
    mode === "transcribe"
      ? "Teams caption scraping is disabled pending live selector validation; transcript snapshots are empty"
      : "Caption scraping is not used by talk-back modes",
  connectedNodeMessage: (node) => `Connected Teams meeting node ready: ${node}`,
  guestJoinCheck: (config) => {
    const ok = Boolean(
      config.chrome.guestName && config.chrome.autoJoin && config.chrome.reuseExistingTab,
    );
    return {
      ok,
      message: ok
        ? "Guest name, auto-join, and tab reuse are configured"
        : "Set chrome.guestName, chrome.autoJoin, and chrome.reuseExistingTab for unattended guest joins",
    };
  },
  missingNodeIdMessage: "Connected Microsoft Teams meetings node did not include a node id.",
  nodeAdapter: TEAMS_MEETINGS_BROWSER_NODE_ADAPTER,
});
