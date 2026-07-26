import {
  MeetingPlatformAdapter,
  createLocalMeetingRealtimeAudioTransport,
  createMeetingRealtimeEngineBindings,
  createNodeMeetingRealtimeAudioTransport,
  startMeetingAgentRealtimeEngine,
  startMeetingRealtimeEngine,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { ZoomMeetingsConfig, ZoomMeetingsMode } from "../config.js";
import {
  ZOOM_MEETINGS_SYSTEM_PROFILER_COMMAND,
  outputMentionsBlackHole2ch,
} from "./chrome-audio-device.js";
import type { ZoomMeetingsChromeHealth, ZoomMeetingsTranscriptSnapshot } from "./types.js";
import {
  ZOOM_MEETINGS_PLATFORM_ADAPTER,
  isZoomMeetingsRealtimeRouteReady,
  isZoomMeetingsTalkBackMode,
} from "./zoom-meetings-platform-adapter.js";
import {
  ZOOM_MEETINGS_BROWSER_NODE_ADAPTER,
  ZOOM_MEETINGS_NODE_COMMAND,
} from "./zoom-meetings-platform-constants.js";

const chromeTransport = MeetingPlatformAdapter.createChromeTransport<
  ZoomMeetingsConfig,
  ZoomMeetingsMode,
  ZoomMeetingsChromeHealth,
  ZoomMeetingsTranscriptSnapshot
>({
  browserNodeAdapter: ZOOM_MEETINGS_BROWSER_NODE_ADAPTER,
  isRealtimeRouteReady: isZoomMeetingsRealtimeRouteReady,
  isTalkBackMode: isZoomMeetingsTalkBackMode,
  meetingLabel: "Zoom meeting",
  nodeCommandName: ZOOM_MEETINGS_NODE_COMMAND,
  outputMentionsAudioDevice: outputMentionsBlackHole2ch,
  platform: ZOOM_MEETINGS_PLATFORM_ADAPTER,
  preserveTrackedBrowserOnEngineFailure: true,
  runtime: {
    createBindings: createMeetingRealtimeEngineBindings,
    createLocalAudioTransport: createLocalMeetingRealtimeAudioTransport,
    createNodeAudioTransport: createNodeMeetingRealtimeAudioTransport,
    startAgentRealtimeEngine: startMeetingAgentRealtimeEngine,
    startRealtimeEngine: startMeetingRealtimeEngine,
  },
  systemProfilerCommand: ZOOM_MEETINGS_SYSTEM_PROFILER_COMMAND,
});

export const assertBlackHole2chAvailable = chromeTransport.assertAudioDeviceAvailable;
export const launchZoomMeetingInChrome = chromeTransport.launchInChrome;
export const launchZoomMeetingOnNode = chromeTransport.launchOnNode;
export const leaveZoomMeetingInBrowser = chromeTransport.leaveInBrowser;
export const readZoomMeetingTranscript = chromeTransport.readTranscript;
export const recoverCurrentZoomMeetingTab = chromeTransport.recoverCurrentTab;
