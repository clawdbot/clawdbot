import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./teams-meetings-platform-adapter.js";

const chromeTransport = MeetingPlatformAdapter.createPluginChromeTransport({
  meetingLabel: "Microsoft Teams meeting",
  platform: TEAMS_MEETINGS_PLATFORM_ADAPTER,
  preserveTrackedBrowserOnEngineFailure: false,
  runtime: MeetingPlatformAdapter.createChromeRuntimeBindings(),
});

export const assertTeamsMeetingsAudioAvailable = chromeTransport.assertAudioDeviceAvailable;
export const launchTeamsMeetingInChrome = chromeTransport.launchInChrome;
export const launchTeamsMeetingOnNode = chromeTransport.launchOnNode;
export const leaveTeamsMeetingInBrowser = chromeTransport.leaveInBrowser;
export const readTeamsMeetingTranscript = chromeTransport.readTranscript;
export const recoverCurrentTeamsMeetingTab = chromeTransport.recoverCurrentTab;
