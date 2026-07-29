import {
  createMeetingChromeRuntimeBindings,
  createMeetingPluginChromeTransport,
} from "openclaw/plugin-sdk/meeting-runtime";
import { ZOOM_MEETINGS_PLATFORM_ADAPTER } from "./zoom-meetings-platform-adapter.js";

const chromeTransport = createMeetingPluginChromeTransport({
  meetingLabel: "Zoom meeting",
  platform: ZOOM_MEETINGS_PLATFORM_ADAPTER,
  preserveTrackedBrowserOnEngineFailure: true,
  runtime: createMeetingChromeRuntimeBindings(),
});

export const assertBlackHole2chAvailable = chromeTransport.assertAudioDeviceAvailable;
export const launchZoomMeetingInChrome = chromeTransport.launchInChrome;
export const launchZoomMeetingOnNode = chromeTransport.launchOnNode;
export const leaveZoomMeetingInBrowser = chromeTransport.leaveInBrowser;
export const readZoomMeetingTranscript = chromeTransport.readTranscript;
export const recoverCurrentZoomMeetingTab = chromeTransport.recoverCurrentTab;
