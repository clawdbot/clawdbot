import { sleep } from "openclaw/plugin-sdk/runtime-env";
import type { GoogleMeetConfig, GoogleMeetMode, GoogleMeetTransport } from "./config.js";
import { normalizeMeetUrl } from "./meet-url.js";
import type {
  GoogleMeetJoinRequest,
  GoogleMeetJoinResult,
  GoogleMeetSession,
} from "./transports/types.js";

type ResolvedGoogleMeetJoin = {
  url: string;
  transport: GoogleMeetTransport;
  mode: GoogleMeetMode;
  agentId: string;
};

export type GoogleMeetRuntimeProbeContext = {
  config: GoogleMeetConfig;
  resolveAgentId(request: GoogleMeetJoinRequest): string;
  list(): GoogleMeetSession[];
  join(request: GoogleMeetJoinRequest): Promise<GoogleMeetJoinResult>;
  isReusable(session: GoogleMeetSession, resolved: ResolvedGoogleMeetJoin): boolean;
  hasHealthHandle(sessionId: string): boolean;
  refreshHealth(sessionId: string): void;
  refreshCaptionHealth(session: GoogleMeetSession): Promise<void>;
};

function resolveMode(request: GoogleMeetJoinRequest, config: GoogleMeetConfig) {
  return request.mode === "realtime" ? "agent" : (request.mode ?? config.defaultMode);
}

function resolveProbeTimeoutMs(input: number | undefined, fallback: number): number {
  if (input === undefined) {
    return Math.min(Math.max(fallback, 1), 120_000);
  }
  if (!Number.isFinite(input) || input <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  return Math.min(Math.trunc(input), 120_000);
}

export async function testGoogleMeetSpeech(
  context: GoogleMeetRuntimeProbeContext,
  request: GoogleMeetJoinRequest,
) {
  if (request.mode === "transcribe") {
    throw new Error(
      "test_speech requires mode: agent or bidi; use join mode: transcribe for observe-only sessions.",
    );
  }
  const requestedMode = request.mode ? resolveMode(request, context.config) : undefined;
  const mode =
    requestedMode === "agent" || requestedMode === "bidi"
      ? requestedMode
      : context.config.defaultMode === "agent" || context.config.defaultMode === "bidi"
        ? context.config.defaultMode
        : "agent";
  const resolved = {
    url: normalizeMeetUrl(request.url),
    transport: request.transport ?? context.config.defaultTransport,
    mode,
    agentId: context.resolveAgentId(request),
  };
  const beforeSessions = context.list();
  const before = new Set(beforeSessions.map((session) => session.id));
  const existing = beforeSessions.find((session) => context.isReusable(session, resolved));
  const existingOutputBytes = existing?.chrome?.health?.lastOutputBytes ?? 0;
  const result = await context.join({
    ...request,
    ...resolved,
    message: request.message ?? "Say exactly: Google Meet speech test complete.",
  });
  const startOutputBytes = existing?.id === result.session.id ? existingOutputBytes : 0;
  let health = result.session.chrome?.health;
  const shouldWait =
    result.spoken === true &&
    health?.manualActionRequired !== true &&
    context.hasHealthHandle(result.session.id);
  if (shouldWait && (health?.lastOutputBytes ?? 0) <= startOutputBytes) {
    const deadline = Date.now() + Math.min(context.config.chrome.joinTimeoutMs, 5_000);
    while (Date.now() < deadline) {
      await sleep(100);
      context.refreshHealth(result.session.id);
      health = result.session.chrome?.health;
      if ((health?.lastOutputBytes ?? 0) > startOutputBytes) {
        break;
      }
    }
  }
  const speechOutputVerified = (health?.lastOutputBytes ?? 0) > startOutputBytes;
  return {
    createdSession: !before.has(result.session.id),
    inCall: health?.inCall,
    manualActionRequired: health?.manualActionRequired,
    manualActionReason: health?.manualActionReason,
    manualActionMessage: health?.manualActionMessage,
    spoken: result.spoken ?? false,
    speechOutputVerified,
    speechOutputTimedOut: shouldWait && !speechOutputVerified,
    speechReady: health?.speechReady,
    speechBlockedReason: health?.speechBlockedReason,
    speechBlockedMessage: health?.speechBlockedMessage,
    audioOutputActive: health?.audioOutputActive,
    lastOutputBytes: health?.lastOutputBytes,
    session: result.session,
  };
}

export async function testGoogleMeetListening(
  context: GoogleMeetRuntimeProbeContext,
  request: GoogleMeetJoinRequest,
) {
  const requestedMode = request.mode ? resolveMode(request, context.config) : undefined;
  if (requestedMode === "agent" || requestedMode === "bidi") {
    throw new Error(
      "test_listen requires mode: transcribe; use test_speech for talk-back sessions.",
    );
  }
  const resolved = {
    url: normalizeMeetUrl(request.url),
    transport: request.transport ?? context.config.defaultTransport,
    mode: "transcribe" as const,
    agentId: context.resolveAgentId(request),
  };
  if (resolved.transport === "twilio") {
    throw new Error("test_listen supports chrome or chrome-node transports");
  }
  const beforeSessions = context.list();
  const before = new Set(beforeSessions.map((session) => session.id));
  const existing = beforeSessions.find((session) => context.isReusable(session, resolved));
  const start = {
    lines: existing?.chrome?.health?.transcriptLines ?? 0,
    at: existing?.chrome?.health?.lastCaptionAt,
    text: existing?.chrome?.health?.lastCaptionText,
  };
  const result = await context.join({ ...request, ...resolved, message: undefined });
  let health = result.session.chrome?.health;
  const advanced = () =>
    (health?.transcriptLines ?? 0) > (existing?.id === result.session.id ? start.lines : 0) ||
    Boolean(health?.lastCaptionAt && health.lastCaptionAt !== start.at) ||
    Boolean(health?.lastCaptionText && health.lastCaptionText !== start.text);
  const shouldWait =
    health?.manualActionRequired !== true &&
    Boolean(
      (result.session.transport === "chrome" || result.session.transport === "chrome-node") &&
      result.session.chrome?.launched,
    );
  if (shouldWait && !advanced()) {
    const deadline =
      Date.now() + resolveProbeTimeoutMs(request.timeoutMs, context.config.chrome.joinTimeoutMs);
    while (Date.now() < deadline) {
      await sleep(250);
      await context.refreshCaptionHealth(result.session);
      health = result.session.chrome?.health;
      if (health?.manualActionRequired || advanced()) {
        break;
      }
    }
  }
  const listenVerified = advanced();
  return {
    createdSession: !before.has(result.session.id),
    inCall: health?.inCall,
    manualActionRequired: health?.manualActionRequired,
    manualActionReason: health?.manualActionReason,
    manualActionMessage: health?.manualActionMessage,
    listenVerified,
    listenTimedOut: shouldWait && !listenVerified && health?.manualActionRequired !== true,
    captioning: health?.captioning,
    captionsEnabledAttempted: health?.captionsEnabledAttempted,
    transcriptLines: health?.transcriptLines,
    lastCaptionAt: health?.lastCaptionAt,
    lastCaptionSpeaker: health?.lastCaptionSpeaker,
    lastCaptionText: health?.lastCaptionText,
    recentTranscript: health?.recentTranscript,
    session: result.session,
  };
}
