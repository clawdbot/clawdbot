import { sleep } from "openclaw/plugin-sdk/runtime-env";
import type { ZoomMeetingsConfig, ZoomMeetingsMode, ZoomMeetingsTransport } from "./config.js";
import { zoomMeetingsInvalidRequest as invalidRequest } from "./errors.js";
import { resolveZoomMeetingsProbeTimeoutMs } from "./probe-timeout.js";
import type {
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

function talkBackMode(mode: ZoomMeetingsMode): boolean {
  return mode === "agent" || mode === "bidi";
}

export async function testZoomMeetingSpeech(
  context: ZoomMeetingsProbeContext,
  request: ZoomMeetingsJoinRequest,
) {
  if (request.mode === "transcribe") {
    throw invalidRequest("test_speech requires mode: agent or bidi");
  }
  const mode = talkBackMode(request.mode ?? context.config.defaultMode)
    ? (request.mode ?? context.config.defaultMode)
    : "agent";
  const resolved = {
    url: request.url,
    transport: request.transport ?? (context.config.chromeNode.node ? "chrome-node" : "chrome"),
    mode,
    agentId: context.resolveAgentId(request),
  } satisfies {
    url: string;
    transport: ZoomMeetingsTransport;
    mode: ZoomMeetingsMode;
    agentId: string;
  };
  const beforeSessions = context.list();
  const before = new Set(beforeSessions.map((session) => session.id));
  const existing = beforeSessions.find((session) => context.isReusable(session, resolved));
  const existingOutputBytes = existing?.chrome?.health?.lastOutputBytes ?? 0;
  const result = await context.join({
    ...request,
    ...resolved,
    message: request.message ?? "Say exactly: Zoom speech test complete.",
  });
  const startOutputBytes = existing?.id === result.session.id ? existingOutputBytes : 0;
  let health = result.session.chrome?.health;
  const shouldWait =
    result.spoken === true &&
    health?.manualActionRequired !== true &&
    context.hasHealthHandle(result.session.id);
  if (shouldWait && (health?.lastOutputBytes ?? 0) <= startOutputBytes) {
    const deadline =
      Date.now() +
      resolveZoomMeetingsProbeTimeoutMs(request.timeoutMs, context.config.chrome.joinTimeoutMs);
    while (Date.now() < deadline && (health?.lastOutputBytes ?? 0) <= startOutputBytes) {
      await sleep(100);
      context.refreshHealth(result.session.id);
      health = result.session.chrome?.health;
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

export async function testZoomMeetingListening(
  context: ZoomMeetingsProbeContext,
  request: ZoomMeetingsJoinRequest,
) {
  if (request.mode && request.mode !== "transcribe") {
    throw invalidRequest("test_listen requires mode: transcribe");
  }
  const resolved = {
    url: request.url,
    transport: request.transport ?? (context.config.chromeNode.node ? "chrome-node" : "chrome"),
    mode: "transcribe" as const,
    agentId: context.resolveAgentId(request),
  };
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
    health?.manualActionRequired !== true && Boolean(result.session.chrome?.browserTab?.targetId);
  let listenVerified = advanced();
  if (shouldWait && !listenVerified) {
    const deadline =
      Date.now() +
      resolveZoomMeetingsProbeTimeoutMs(request.timeoutMs, context.config.chrome.joinTimeoutMs);
    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadlineReached = new Promise<boolean>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(false), remainingMs);
      });
      // Browser recovery receives this same remaining budget. The outer race
      // keeps the probe wall-clock bounded while the inner deadline prevents
      // the per-target browser act from lingering on its normal longer timeout.
      const refreshed = await Promise.race([
        context.refreshCaptionHealth(result.session, remainingMs).then(() => true),
        deadlineReached,
      ]).finally(() => {
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
        }
      });
      if (!refreshed) {
        break;
      }
      health = result.session.chrome?.health;
      if (Date.now() >= deadline) {
        break;
      }
      if (advanced()) {
        listenVerified = true;
      }
      if (listenVerified || health?.manualActionRequired) {
        break;
      }
      const retryDelayMs = deadline - Date.now();
      if (retryDelayMs <= 0) {
        break;
      }
      await sleep(Math.min(250, retryDelayMs));
    }
  }
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
