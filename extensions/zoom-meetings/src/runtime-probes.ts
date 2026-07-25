import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { ZoomMeetingsConfig, ZoomMeetingsMode, ZoomMeetingsTransport } from "./config.js";
import { zoomMeetingsInvalidRequest } from "./errors.js";
import { resolveZoomMeetingsProbeTimeoutMs } from "./probe-timeout.js";
import type {
  ZoomMeetingsChromeHealth,
  ZoomMeetingsJoinRequest,
  ZoomMeetingsJoinResult,
  ZoomMeetingsSession,
} from "./transports/types.js";

export type ZoomMeetingsProbeContext = {
  config: ZoomMeetingsConfig;
  resolveAgentId(request: ZoomMeetingsJoinRequest): string;
  list(): ZoomMeetingsSession[];
  join(request: ZoomMeetingsJoinRequest): Promise<ZoomMeetingsJoinResult>;
  isReusable(
    session: ZoomMeetingsSession,
    resolved: {
      url: string;
      transport: ZoomMeetingsTransport;
      mode: ZoomMeetingsMode;
      agentId: string;
    },
  ): boolean;
  hasHealthHandle(sessionId: string): boolean;
  refreshHealth(sessionId: string): void;
  refreshCaptionHealth(session: ZoomMeetingsSession, timeoutMs: number): Promise<void>;
};

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
  resolveTimeoutMs: resolveZoomMeetingsProbeTimeoutMs,
  shouldWaitForListening: (session) => Boolean(session.chrome?.browserTab?.targetId),
  talkBackMode: (mode) => mode === "agent" || mode === "bidi",
});

export const testZoomMeetingListening: (
  context: ZoomMeetingsProbeContext,
  request: ZoomMeetingsJoinRequest,
) => ReturnType<typeof probes.testListening> = probes.testListening;

export const testZoomMeetingSpeech: (
  context: ZoomMeetingsProbeContext,
  request: ZoomMeetingsJoinRequest,
) => ReturnType<typeof probes.testSpeech> = probes.testSpeech;
