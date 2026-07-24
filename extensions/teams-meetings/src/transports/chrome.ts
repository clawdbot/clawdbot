import {
  MeetingPlatformAdapter,
  createLocalMeetingRealtimeAudioTransport,
  createMeetingRealtimeEngineBindings,
  createNodeMeetingRealtimeAudioTransport,
  startMeetingAgentRealtimeEngine,
  startMeetingRealtimeEngine,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { TeamsMeetingsConfig, TeamsMeetingsMode } from "../config.js";
import {
  TEAMS_MEETINGS_SYSTEM_PROFILER_COMMAND,
  outputMentionsBlackHole2ch,
} from "./chrome-audio-device.js";
import {
  TEAMS_MEETINGS_PLATFORM_ADAPTER,
  isTeamsMeetingsRealtimeRouteReady,
  isTeamsMeetingsTalkBackMode,
} from "./teams-meetings-platform-adapter.js";
import {
  TEAMS_MEETINGS_BROWSER_NODE_ADAPTER,
  TEAMS_MEETINGS_NODE_COMMAND,
} from "./teams-meetings-platform-constants.js";
import type { TeamsMeetingsChromeHealth, TeamsMeetingsTranscriptSnapshot } from "./types.js";

const chromeTransport = MeetingPlatformAdapter.createChromeTransport<
  TeamsMeetingsConfig,
  TeamsMeetingsMode,
  TeamsMeetingsChromeHealth,
  TeamsMeetingsTranscriptSnapshot
>({
  browserNodeAdapter: TEAMS_MEETINGS_BROWSER_NODE_ADAPTER,
  isRealtimeRouteReady: isTeamsMeetingsRealtimeRouteReady,
  isTalkBackMode: isTeamsMeetingsTalkBackMode,
  meetingLabel: "Microsoft Teams meeting",
  nodeCommandName: TEAMS_MEETINGS_NODE_COMMAND,
  outputMentionsAudioDevice: outputMentionsBlackHole2ch,
  platform: TEAMS_MEETINGS_PLATFORM_ADAPTER,
  preserveTrackedBrowserOnEngineFailure: false,
  runtime: {
    createBindings: createMeetingRealtimeEngineBindings,
    createLocalAudioTransport: createLocalMeetingRealtimeAudioTransport,
    createNodeAudioTransport: createNodeMeetingRealtimeAudioTransport,
    startAgentRealtimeEngine: startMeetingAgentRealtimeEngine,
    startRealtimeEngine: startMeetingRealtimeEngine,
  },
  systemProfilerCommand: TEAMS_MEETINGS_SYSTEM_PROFILER_COMMAND,
});

export const assertBlackHole2chAvailable = chromeTransport.assertAudioDeviceAvailable;
export const launchTeamsMeetingInChrome = chromeTransport.launchInChrome;
export const launchTeamsMeetingOnNode = chromeTransport.launchOnNode;
export const leaveTeamsMeetingInBrowser = chromeTransport.leaveInBrowser;
export const readTeamsMeetingTranscript = chromeTransport.readTranscript;
export const recoverCurrentTeamsMeetingTab = chromeTransport.recoverCurrentTab;
