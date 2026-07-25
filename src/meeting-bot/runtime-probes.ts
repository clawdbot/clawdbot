import { sleep } from "../utils/sleep.js";
import type { MeetingBrowserHealth } from "./session-types.js";

type MeetingProbeHealth = MeetingBrowserHealth & {
  audioOutputActive?: boolean;
  captioning?: boolean;
  captionsEnabledAttempted?: boolean;
  lastCaptionAt?: string;
  lastCaptionSpeaker?: string;
  lastCaptionText?: string;
  lastOutputBytes?: number;
  lastOutputLoopbackAt?: string;
  lastOutputLoopbackCorrelation?: number;
  lastOutputLoopbackPeak?: number;
  lastOutputLoopbackRms?: number;
  outputGeneration?: number;
  outputLoopbackSignalBytes?: number;
  recentTranscript?: Array<{ at?: string; speaker?: string; text: string }>;
  transcriptLines?: number;
  verifiedOutputGeneration?: number;
};

type MeetingProbeSession<Health extends MeetingProbeHealth> = {
  id: string;
  chrome?: {
    launched: boolean;
    browserTab?: { targetId?: string };
    health?: Health;
  };
};

type MeetingProbeRequest<Mode extends string, Transport extends string> = {
  agentId?: string;
  message?: string;
  mode?: Mode;
  timeoutMs?: number;
  transport?: Transport;
  url: string;
};

type MeetingProbeConfig<Mode extends string> = {
  defaultMode: Mode;
  chrome: { joinTimeoutMs: number };
  chromeNode: { node?: string };
};

type MeetingProbeContext<
  Config extends MeetingProbeConfig<Mode>,
  Mode extends string,
  Transport extends string,
  Health extends MeetingProbeHealth,
  Session extends MeetingProbeSession<Health>,
  Request extends MeetingProbeRequest<Mode, Transport>,
> = {
  config: Config;
  resolveAgentId(request: Request): string;
  list(): Session[];
  join(request: Request): Promise<{ session: Session; spoken?: boolean }>;
  isReusable(
    session: Session,
    resolved: { url: string; transport: Transport; mode: Mode; agentId: string },
  ): boolean;
  hasHealthHandle(sessionId: string): boolean;
  refreshHealth(sessionId: string): void;
  refreshCaptionHealth(session: Session, timeoutMs: number): Promise<void>;
};

type MeetingRuntimeProbeOptions<
  Mode extends string,
  Health extends MeetingProbeHealth,
  Session extends MeetingProbeSession<Health>,
> = {
  defaultSpeechMessage: string;
  invalidRequest(message: string): Error;
  resolveTimeoutMs(input: number | undefined, fallback: number): number;
  shouldWaitForListening(session: Session): boolean;
  talkBackMode(mode: Mode): boolean;
};

export function createMeetingRuntimeProbes<
  Config extends MeetingProbeConfig<Mode>,
  Mode extends string,
  Transport extends string,
  Health extends MeetingProbeHealth,
  Session extends MeetingProbeSession<Health>,
  Request extends MeetingProbeRequest<Mode, Transport>,
>(options: MeetingRuntimeProbeOptions<Mode, Health, Session>) {
  type Context = MeetingProbeContext<Config, Mode, Transport, Health, Session, Request>;

  const testSpeech = async (context: Context, request: Request) => {
    if (request.mode === "transcribe") {
      throw options.invalidRequest("test_speech requires mode: agent or bidi");
    }
    const requestedMode = request.mode ?? context.config.defaultMode;
    const mode = options.talkBackMode(requestedMode) ? requestedMode : ("agent" as Mode);
    const resolved = {
      url: request.url,
      transport:
        request.transport ??
        (context.config.chromeNode.node ? ("chrome-node" as Transport) : ("chrome" as Transport)),
      mode,
      agentId: context.resolveAgentId(request),
    };
    const beforeSessions = context.list();
    const before = new Set(beforeSessions.map((session) => session.id));
    const existing = beforeSessions.find((session) => context.isReusable(session, resolved));
    const existingBaseline = {
      outputBytes: existing?.chrome?.health?.lastOutputBytes ?? 0,
      outputGeneration: existing?.chrome?.health?.outputGeneration ?? 0,
    };
    const result = await context.join({
      ...request,
      ...resolved,
      message: request.message ?? options.defaultSpeechMessage,
    });
    const baseline =
      existing?.id === result.session.id
        ? existingBaseline
        : { outputBytes: 0, outputGeneration: 0 };
    let health = result.session.chrome?.health;
    const verified = () =>
      (health?.lastOutputBytes ?? 0) > baseline.outputBytes &&
      (health?.outputGeneration ?? 0) > baseline.outputGeneration &&
      health?.verifiedOutputGeneration === health?.outputGeneration;
    const shouldWait =
      result.spoken === true &&
      health?.manualActionRequired !== true &&
      context.hasHealthHandle(result.session.id);
    if (shouldWait && !verified()) {
      const deadline =
        Date.now() +
        options.resolveTimeoutMs(request.timeoutMs, context.config.chrome.joinTimeoutMs);
      while (Date.now() < deadline && !verified()) {
        await sleep(100);
        context.refreshHealth(result.session.id);
        health = result.session.chrome?.health;
      }
    }
    const speechOutputVerified = verified();
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
      outputLoopbackSignalBytes: health?.outputLoopbackSignalBytes,
      lastOutputLoopbackAt: health?.lastOutputLoopbackAt,
      lastOutputLoopbackCorrelation: health?.lastOutputLoopbackCorrelation,
      lastOutputLoopbackRms: health?.lastOutputLoopbackRms,
      lastOutputLoopbackPeak: health?.lastOutputLoopbackPeak,
      outputGeneration: health?.outputGeneration,
      verifiedOutputGeneration: health?.verifiedOutputGeneration,
      session: result.session,
    };
  };

  const testListening = async (context: Context, request: Request) => {
    if (request.mode && request.mode !== "transcribe") {
      throw options.invalidRequest("test_listen requires mode: transcribe");
    }
    const resolved = {
      url: request.url,
      transport:
        request.transport ??
        (context.config.chromeNode.node ? ("chrome-node" as Transport) : ("chrome" as Transport)),
      mode: "transcribe" as Mode,
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
      health?.manualActionRequired !== true && options.shouldWaitForListening(result.session);
    let listenVerified = advanced();
    if (shouldWait && !listenVerified) {
      const deadline =
        Date.now() +
        options.resolveTimeoutMs(request.timeoutMs, context.config.chrome.joinTimeoutMs);
      while (Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          break;
        }
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const deadlineReached = new Promise<boolean>((resolve) => {
          deadlineTimer = setTimeout(() => resolve(false), remainingMs);
        });
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
  };

  return { testListening, testSpeech };
}
