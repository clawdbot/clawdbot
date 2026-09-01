/**
 * Runtime adapter for realtime voice control of active OpenClaw agent runs.
 *
 * The shared module owns classification and message contracts; this adapter
 * binds those contracts to embedded-run abort, status, and steering primitives.
 */
import type {
  ActiveEmbeddedRunOwner,
  EmbeddedAgentQueueMessageOutcome,
} from "../agents/embedded-agent-runner/runs.js";
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
} from "./agent-run-control-shared.js";

type RealtimeVoiceAgentControlDeps = {
  abortEmbeddedAgentRun: (sessionId: string) => boolean;
  queueEmbeddedAgentMessageWithOutcomeAsync: (
    sessionId: string,
    text: string,
    options?: {
      steeringMode?: "all";
      debounceMs?: number;
      isInboundUserMessage?: boolean;
      taskSuggestionDeliveryMode?: undefined;
    },
  ) => Promise<EmbeddedAgentQueueMessageOutcome>;
  getDiagnosticSessionActivitySnapshot: (params: {
    sessionId?: string;
    sessionKey?: string;
  }) => RealtimeVoiceAgentRunActivity;
  resolveActiveEmbeddedRunSessionId: (sessionKey: string) => string | undefined;
  resolveActiveEmbeddedRunOwnerByRunId?: (runId: string) => ActiveEmbeddedRunOwner | undefined;
  resolveActiveReplyRunOwnerForSignal?: (
    signal: AbortSignal,
  ) => Pick<ActiveEmbeddedRunOwner, "sessionId" | "sessionKey" | "abort"> | undefined;
};

/** Apply a spoken status, cancel, steer, or follow-up request to an active run. */
export async function controlRealtimeVoiceAgentRun(
  params: {
    sessionKey: string;
    /** Exact admitted owner; null forbids lookup, omission retains legacy session-key control. */
    runTarget?: {
      runId: string;
      signal: AbortSignal;
      isCurrent: (sessionId?: string) => boolean;
    } | null;
    text: string;
    mode?: unknown;
    recentEvents?: readonly TalkEvent[];
  },
  providedDeps?: RealtimeVoiceAgentControlDeps,
): Promise<RealtimeVoiceAgentControlResult> {
  // Provider registration consumes the shared policy without starting the agent runtime.
  const deps =
    providedDeps ?? (await import("./agent-run-control.runtime.js")).realtimeVoiceControlRuntime;
  const sessionKey = params.sessionKey.trim();
  const text = params.text.trim();
  const intent = resolveRealtimeVoiceAgentControlIntent({ text, mode: params.mode });
  const mode = intent.mode;
  const target = params.runTarget;
  const candidate =
    target && !target.signal.aborted && target.isCurrent()
      ? (deps.resolveActiveEmbeddedRunOwnerByRunId?.(target.runId) ??
        deps.resolveActiveReplyRunOwnerForSignal?.(target.signal))
      : undefined;
  const exactOwner =
    candidate?.sessionKey === sessionKey && target?.isCurrent(candidate.sessionId)
      ? candidate
      : undefined;
  const sessionId =
    target === undefined
      ? deps.resolveActiveEmbeddedRunSessionId(sessionKey)
      : exactOwner?.sessionId;
  // Global keys are shared across agents. Exact selectors never consult another
  // session's key-only diagnostics, including when their live owner disappeared.
  const activity =
    target === undefined
      ? deps.getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey })
      : sessionId
        ? deps.getDiagnosticSessionActivitySnapshot({ sessionId })
        : undefined;
  const active = Boolean(sessionId || activity?.activeWorkKind || activity?.hasActiveEmbeddedRun);

  // Status is read-only and can answer from diagnostic activity even when the
  // active embedded run id has already disappeared.
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

  // Cancellation requires a concrete embedded-run id; activity-only snapshots
  // are not abortable and should return an explicit no-active-run response.
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
    const aborted =
      target === undefined ? deps.abortEmbeddedAgentRun(sessionId) : exactOwner?.abort() === true;
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

  // Steering and follow-up both enqueue to the active run; follow-up is wrapped
  // so the runner treats it as deferred context instead of an immediate pivot.
  const steerText = mode === "followup" ? buildRealtimeVoiceAgentFollowupSteeringText(text) : text;
  const outcome = await deps.queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, steerText, {
    steeringMode: "all",
    debounceMs: 0,
    isInboundUserMessage: true,
    // Talk cannot present task suggestions, so spoken user input must not inherit
    // a capable TUI run's model-facing task tools.
    taskSuggestionDeliveryMode: undefined,
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
