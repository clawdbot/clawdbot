import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { GoogleMeetConfig, GoogleMeetMode, GoogleMeetTransport } from "./config.js";
import { normalizeMeetUrl } from "./meet-url.js";
import { resolveGoogleMeetProbeTimeoutMs } from "./probe-timeout.js";
import type {
  GoogleMeetChromeHealth,
  GoogleMeetJoinRequest,
  GoogleMeetJoinResult,
  GoogleMeetSession,
} from "./transports/types.js";

export type GoogleMeetRuntimeProbeContext = {
  config: GoogleMeetConfig;
  resolveAgentId(request: GoogleMeetJoinRequest): string;
  list(): GoogleMeetSession[];
  join(request: GoogleMeetJoinRequest): Promise<GoogleMeetJoinResult>;
  isReusable(
    session: GoogleMeetSession,
    resolved: {
      url: string;
      transport: GoogleMeetTransport;
      mode: GoogleMeetMode;
      agentId: string;
    },
  ): boolean;
  hasHealthHandle(sessionId: string): boolean;
  refreshHealth(sessionId: string): void;
  refreshCaptionHealth(session: GoogleMeetSession): Promise<void>;
};

const probes = MeetingPlatformAdapter.createRuntimeProbes<
  GoogleMeetConfig,
  GoogleMeetMode,
  GoogleMeetTransport,
  GoogleMeetChromeHealth,
  GoogleMeetSession,
  GoogleMeetJoinRequest
>({
  defaultSpeechMessage: "Say exactly: Google Meet speech test complete.",
  invalidRequest: (message) => new Error(message),
  resolveTimeoutMs: resolveGoogleMeetProbeTimeoutMs,
  shouldWaitForListening: (session) =>
    Boolean(
      (session.transport === "chrome" || session.transport === "chrome-node") &&
      session.chrome?.launched,
    ),
  talkBackMode: MeetingPlatformAdapter.isTalkBackMode,
  normalizeUrl: normalizeMeetUrl,
  resolveRequestMode: (mode) => (mode === "realtime" ? "agent" : mode),
  defaultTransport: (config) => config.defaultTransport,
  validateListeningTransport: (transport) => {
    if (transport === "twilio") {
      throw new Error("test_listen supports chrome or chrome-node transports");
    }
  },
  // Unlike Zoom and Teams, Meet keeps a short observe-mode default so unattended
  // speech checks stay fast (#73256). An explicit caller timeout still wins, capped
  // like every other probe; dropping the request here is what made timeoutMs
  // unreachable for test_speech.
  resolveSpeechTimeoutMs: (request, config) =>
    request.timeoutMs === undefined
      ? Math.min(config.chrome.joinTimeoutMs, 5_000)
      : resolveGoogleMeetProbeTimeoutMs(request.timeoutMs, config.chrome.joinTimeoutMs),
  refreshCaptionHealth: async (context, session) => await context.refreshCaptionHealth(session),
  speechModeError:
    "test_speech requires mode: agent or bidi; use join mode: transcribe for observe-only sessions.",
  listeningModeError:
    "test_listen requires mode: transcribe; use test_speech for talk-back sessions.",
});

export const testGoogleMeetListening: (
  context: GoogleMeetRuntimeProbeContext,
  request: GoogleMeetJoinRequest,
) => ReturnType<typeof probes.testListening> = probes.testListening;

export const testGoogleMeetSpeech: (
  context: GoogleMeetRuntimeProbeContext,
  request: GoogleMeetJoinRequest,
) => ReturnType<typeof probes.testSpeech> = probes.testSpeech;
