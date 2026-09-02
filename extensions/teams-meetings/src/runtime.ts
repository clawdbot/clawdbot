import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { TeamsMeetingsConfig, TeamsMeetingsMode, TeamsMeetingsTransport } from "./config.js";
import { testTeamsMeetingListening, testTeamsMeetingSpeech } from "./runtime-probes.js";
import { getTeamsMeetingsSetupStatus } from "./runtime-setup.js";
import {
  launchTeamsMeetingInChrome,
  launchTeamsMeetingOnNode,
  leaveTeamsMeetingInBrowser,
  readTeamsMeetingTranscript,
  recoverCurrentTeamsMeetingTab,
} from "./transports/chrome.js";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./transports/teams-meetings-platform-adapter.js";
import type { TeamsMeetingsChromeHealth } from "./transports/types.js";

export const TeamsMeetingsRuntime = MeetingPlatformAdapter.createRuntimeFacade<
  TeamsMeetingsConfig,
  TeamsMeetingsTransport,
  TeamsMeetingsMode,
  TeamsMeetingsChromeHealth,
  {
    setup: Awaited<ReturnType<typeof getTeamsMeetingsSetupStatus>>;
    listening: Awaited<ReturnType<typeof testTeamsMeetingListening>>;
    speech: Awaited<ReturnType<typeof testTeamsMeetingSpeech>>;
  }
>({
  platform: TEAMS_MEETINGS_PLATFORM_ADAPTER,
  transport: {
    launchInChrome: launchTeamsMeetingInChrome,
    launchOnNode: launchTeamsMeetingOnNode,
    leaveInBrowser: leaveTeamsMeetingInBrowser,
    readTranscript: readTeamsMeetingTranscript,
    recoverCurrentTab: recoverCurrentTeamsMeetingTab,
  },
  probes: {
    setupStatus: getTeamsMeetingsSetupStatus,
    testListening: testTeamsMeetingListening,
    testSpeech: testTeamsMeetingSpeech,
  },
  messages: {
    durableTranscripts: { providerId: "teams", providerName: "Microsoft Teams" },
    joined: {
      local:
        "Teams guest joined in local Chrome with realtime audio through the native virtual-audio backend.",
      node: "Teams guest joined in Chrome on the selected node with realtime audio through the node bridge.",
      transcribe: "Teams guest joined observe-only with live-caption transcript capture.",
      waiting:
        "Teams guest join is waiting for the browser to become ready before starting realtime audio.",
    },
    leaveFailed: (error) => `Browser control could not leave the Teams meeting tab: ${error}`,
    noTrackedTab:
      "No tracked Teams meeting tab; leave the browser meeting manually if it is still active.",
    sharedTab: "Kept the shared Teams meeting tab open for another active session.",
    sessionRuntime: {
      previousBrowserLeaveFailed:
        "Could not leave the previous Teams meeting tab before reassignment.",
      reassignedSessionNote:
        "Ended before the same Teams meeting tab was reassigned to another agent.",
      reusedSessionNote: "Reused existing active Microsoft Teams meeting session.",
      replacementBrowserLeaveFailed:
        "Could not leave the previous Teams meeting tab before reassignment.",
      speechBlockedFallback: "Realtime speech blocked until Microsoft Teams is ready.",
      speech: {
        audioBridgeUnavailable: "Realtime speech requires an active Chrome audio bridge.",
        browserUnverified: "Microsoft Teams browser state has not been verified yet.",
        microphoneMuted: "Turn on the OpenClaw Teams microphone before asking OpenClaw to speak.",
        microphoneMutedReason: "teams-microphone-muted",
        notInCall: "Microsoft Teams has not reported that the browser guest is in the call.",
        notInCallReason: "not-in-call",
        browserUnverifiedReason: "browser-unverified",
        audioBridgeUnavailableReason: "audio-bridge-unavailable",
      },
    },
  },
});
