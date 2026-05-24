import type { EmbeddedPiQueueMessageOutcome } from "../agents/pi-embedded-runner/runs.js";
import {
  abortEmbeddedPiRun,
  queueEmbeddedPiMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
} from "../agents/pi-embedded-runner/runs.js";
import { getDiagnosticSessionActivitySnapshot } from "../logging/diagnostic-run-activity.js";
import {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentFollowupSteeringText,
  formatRealtimeVoiceAgentQueueRejection,
  formatRealtimeVoiceAgentStatus,
  resolveRealtimeVoiceAgentControlIntent,
  type RealtimeVoiceAgentControlResult,
  type RealtimeVoiceAgentRunActivity,
} from "./agent-run-control-shared.js";
import type { TalkEvent } from "./talk-events.js";

export {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentControlSpeechMessage,
  classifyRealtimeVoiceAgentControlText,
  normalizeRealtimeVoiceAgentControlMode,
  parseRealtimeVoiceAgentControlToolArgs,
  REALTIME_VOICE_AGENT_CONTROL_MODES,
  REALTIME_VOICE_AGENT_CONTROL_TOOL,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  resolveRealtimeVoiceAgentControlIntent,
  shouldAutoControlRealtimeVoiceAgentText,
  type RealtimeVoiceAgentControlMode,
  type RealtimeVoiceAgentControlIntent,
  type RealtimeVoiceAgentControlProviderResult,
  type RealtimeVoiceAgentControlResult,
  type RealtimeVoiceAgentRunActivity,
} from "./agent-run-control-shared.js";

type RealtimeVoiceAgentControlDeps = {
  abortEmbeddedPiRun: (sessionId: string) => boolean;
  queueEmbeddedPiMessageWithOutcomeAsync: (
    sessionId: string,
    text: string,
    options?: { steeringMode?: "all"; debounceMs?: number },
  ) => Promise<EmbeddedPiQueueMessageOutcome>;
  getDiagnosticSessionActivitySnapshot: (params: {
    sessionId?: string;
    sessionKey?: string;
  }) => RealtimeVoiceAgentRunActivity;
  resolveActiveEmbeddedRunSessionId: (sessionKey: string) => string | undefined;
};

const defaultDeps: RealtimeVoiceAgentControlDeps = {
  abortEmbeddedPiRun,
  getDiagnosticSessionActivitySnapshot,
  queueEmbeddedPiMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
};

export async function controlRealtimeVoiceAgentRun(
  params: {
    sessionKey: string;
    text: string;
    mode?: unknown;
    recentEvents?: readonly TalkEvent[];
  },
  deps: RealtimeVoiceAgentControlDeps = defaultDeps,
): Promise<RealtimeVoiceAgentControlResult> {
  const sessionKey = params.sessionKey.trim();
  const text = params.text.trim();
  const intent = resolveRealtimeVoiceAgentControlIntent({ text, mode: params.mode });
  const mode = intent.mode;
  const sessionId = deps.resolveActiveEmbeddedRunSessionId(sessionKey);
  const activity = deps.getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey });
  const active = Boolean(sessionId || activity.activeWorkKind || activity.hasActiveEmbeddedRun);

  if (mode === "status") {
    return {
      ok: true,
      mode,
      sessionKey,
      ...(sessionId ? { sessionId } : {}),
      active,
      message: formatRealtimeVoiceAgentStatus({
        active,
        recentEvents: params.recentEvents,
        activity,
      }),
      speak: true,
      show: true,
      suppress: false,
    };
  }

  if (mode === "cancel") {
    if (!sessionId) {
      return {
        ok: false,
        mode,
        sessionKey,
        active: false,
        aborted: false,
        reason: "no_active_run",
        message: "There is no active OpenClaw run to cancel.",
        speak: true,
        show: true,
        suppress: false,
      };
    }
    const aborted = deps.abortEmbeddedPiRun(sessionId);
    const message = aborted
      ? "Cancelled the active OpenClaw run."
      : "OpenClaw could not cancel the active run.";
    return {
      ok: aborted,
      mode,
      sessionKey,
      sessionId,
      active: true,
      aborted,
      ...(aborted ? {} : { reason: "abort_rejected" }),
      message,
      speak: true,
      show: true,
      suppress: false,
      ...(aborted ? { providerResult: buildRealtimeVoiceAgentCancelProviderResult(message) } : {}),
    };
  }

  if (!sessionId) {
    return {
      ok: false,
      mode,
      sessionKey,
      active: false,
      queued: false,
      reason: "no_active_run",
      message: "There is no active OpenClaw run to steer.",
      speak: true,
      show: true,
      suppress: false,
    };
  }

  const steerText = mode === "followup" ? buildRealtimeVoiceAgentFollowupSteeringText(text) : text;
  const outcome = await deps.queueEmbeddedPiMessageWithOutcomeAsync(sessionId, steerText, {
    steeringMode: "all",
    debounceMs: 0,
  });
  if (!outcome.queued) {
    return {
      ok: false,
      mode,
      sessionKey,
      sessionId: outcome.sessionId,
      active: true,
      queued: false,
      reason: outcome.reason,
      message: formatRealtimeVoiceAgentQueueRejection(mode, outcome.reason),
      speak: true,
      show: true,
      suppress: false,
    };
  }

  return {
    ok: true,
    mode,
    sessionKey,
    sessionId: outcome.sessionId,
    active: true,
    queued: true,
    target: outcome.target,
    message:
      mode === "followup"
        ? "Queued that follow-up for the active OpenClaw run."
        : "Got it. I steered the active run.",
    speak: true,
    show: true,
    suppress: false,
    ...(outcome.enqueuedAtMs !== undefined ? { enqueuedAtMs: outcome.enqueuedAtMs } : {}),
    ...(outcome.deliveredAtMs !== undefined ? { deliveredAtMs: outcome.deliveredAtMs } : {}),
  };
}
