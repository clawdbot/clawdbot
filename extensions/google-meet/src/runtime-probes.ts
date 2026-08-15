import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { GoogleMeetConfig, GoogleMeetMode, GoogleMeetTransport } from "./config.js";
import { normalizeMeetUrl } from "./meet-url.js";
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

function resolveProbeTimeoutMs(input: number | undefined, fallback: number): number {
  if (input === undefined) {
    return Math.min(Math.max(fallback, 1), 120_000);
  }
  if (!Number.isFinite(input) || input <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  return Math.min(Math.trunc(input), 120_000);
}

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
  resolveTimeoutMs: resolveProbeTimeoutMs,
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
  resolveSpeechTimeoutMs: (_request, config) => Math.min(config.chrome.joinTimeoutMs, 5_000),
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
