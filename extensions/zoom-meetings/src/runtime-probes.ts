import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { ZoomMeetingsConfig, ZoomMeetingsMode, ZoomMeetingsTransport } from "./config.js";
import { zoomMeetingsInvalidRequest } from "./errors.js";
import type {
  ZoomMeetingsChromeHealth,
  ZoomMeetingsJoinRequest,
  ZoomMeetingsPluginTypes,
  ZoomMeetingsSession,
} from "./transports/types.js";

export type ZoomMeetingsProbeContext = ZoomMeetingsPluginTypes["ProbeContext"];

const probes = MeetingPlatformAdapter.createRuntimeProbes<
  ZoomMeetingsConfig,
  ZoomMeetingsMode,
  ZoomMeetingsTransport,
  ZoomMeetingsChromeHealth,
  ZoomMeetingsSession,
  ZoomMeetingsJoinRequest
>({
  defaultSpeechMessage: "Say exactly: Zoom speech test complete.",
  invalidRequest: zoomMeetingsInvalidRequest,
  resolveTimeoutMs: (input, fallback) =>
    MeetingPlatformAdapter.resolveProbeTimeoutMs(input, fallback, zoomMeetingsInvalidRequest),
  shouldWaitForListening: (session) => Boolean(session.chrome?.browserTab?.targetId),
  talkBackMode: MeetingPlatformAdapter.isTalkBackMode,
});

export const testZoomMeetingListening = probes.testListening;
export const testZoomMeetingSpeech = probes.testSpeech;
