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
import type { ReplyToolAuthorityOverlay } from "../auto-reply/reply/reply-run-registry.contracts.js";
import { isAbortError } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getDiagnosticSessionActivitySnapshot } from "../logging/diagnostic-run-activity.js";
import {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentFollowupSteeringText,
  formatRealtimeVoiceAgentQueueRejection,
  formatRealtimeVoiceAgentStatus,
  resolveRealtimeVoiceAgentControlIntent,
  type RealtimeVoiceAgentControlProviderResult,
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

const controlResultPresentation = { speak: true, show: true, suppress: false };

/** Host error projection needs server-side redaction, outside browser-shared contracts. */
export function buildRealtimeVoiceAgentErrorProviderResult(
  error: unknown,
): RealtimeVoiceAgentControlProviderResult | { error: string } {
  return isAbortError(error)
    ? buildRealtimeVoiceAgentCancelProviderResult()
    : { error: formatErrorMessage(error) };
}

type RealtimeVoiceAgentControlDeps = {
  queueGuardedEmbeddedAgentMessageWithOutcomeAsync?: typeof import("../agents/embedded-agent-runner/runs.js").queueGuardedEmbeddedAgentMessageWithOutcomeAsync;
  abortEmbeddedAgentRun: (sessionId: string) => boolean;
  queueEmbeddedAgentMessageWithOutcomeAsync: (
    sessionId: string,
    text: string,
    options?: {
      steeringMode?: "all";
      debounceMs?: number;
      isInboundUserMessage?: boolean;
      taskSuggestionDeliveryMode?: undefined;
      toolAuthorityOverlay?: ReplyToolAuthorityOverlay;
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
    getToolAuthorityOverlay?: () => ReplyToolAuthorityOverlay;
    mode?: unknown;
    recentEvents?: readonly TalkEvent[];
  },
  providedDeps?: RealtimeVoiceAgentControlDeps,
): Promise<RealtimeVoiceAgentControlResult> {
  const sessionKey = params.sessionKey.trim();
  const text = params.text.trim();
  const mode = resolveRealtimeVoiceAgentControlIntent({ text, mode: params.mode }).mode;
  const controlResultContext = { mode, sessionKey };
  const target = params.runTarget;
  let commands = providedDeps;
  // Exact registered runs need their owner-bound selector, never a key-only lookup.
  // Cold requests without a live registration do not load the mutating runtime.
  if (!commands && target && !target.signal.aborted && target.isCurrent()) {
    commands = (await import("./agent-run-control.runtime.js")).realtimeVoiceControlRuntime;
  }
  const projections =
    commands ??
    (target === undefined
      ? await import("../agents/embedded-agent-runner/active-run-projections.js")
      : undefined);
  const resolveCurrentRun = () => {
    const candidate =
      target && !target.signal.aborted && target.isCurrent()
        ? (commands?.resolveActiveEmbeddedRunOwnerByRunId?.(target.runId) ??
          commands?.resolveActiveReplyRunOwnerForSignal?.(target.signal))
        : undefined;
    const exactOwner =
      candidate?.sessionKey === sessionKey && target?.isCurrent(candidate.sessionId)
        ? candidate
        : undefined;
    const sessionId =
      target === undefined
        ? projections?.resolveActiveEmbeddedRunSessionId(sessionKey)
        : exactOwner?.sessionId;
    return { sessionId, exactOwner };
  };
  let current = resolveCurrentRun();
  const readActivity =
    providedDeps?.getDiagnosticSessionActivitySnapshot ?? getDiagnosticSessionActivitySnapshot;
  // Global keys are shared across agents. Exact selectors never consult another
  // session's key-only diagnostics, including when their live owner disappeared.
  const activity =
    target === undefined
      ? readActivity({ sessionId: current.sessionId, sessionKey })
      : current.sessionId
        ? readActivity({ sessionId: current.sessionId })
        : undefined;
  const active = Boolean(
    current.sessionId || activity?.activeWorkKind || activity?.hasActiveEmbeddedRun,
  );

  // Without an exact live registration, status stays on lightweight diagnostics
  // and remains available even when the mutating runtime cannot load.
  if (mode === "status") {
    return {
      ok: true,
      ...controlResultContext,
      ...(current.sessionId ? { sessionId: current.sessionId } : {}),
      active,
      message: formatRealtimeVoiceAgentStatus({
        active,
        recentEvents: params.recentEvents,
        activity,
      }),
      ...controlResultPresentation,
    };
  }

  const noActiveRun = (): RealtimeVoiceAgentControlResult => ({
    ok: false,
    ...controlResultContext,
    active: false,
    ...(mode === "cancel" ? { aborted: false } : { queued: false }),
    reason: "no_active_run",
    message: `There is no active OpenClaw run to ${mode === "cancel" ? "cancel" : "steer"}.`,
    ...controlResultPresentation,
  });
  if (!current.sessionId) {
    return noActiveRun();
  }
  if (!commands) {
    commands = (await import("./agent-run-control.runtime.js")).realtimeVoiceControlRuntime;
    // Loading commands can outlive admission; resolve the exact target again
    // in the continuation that performs the action.
    current = resolveCurrentRun();
  }
  const { sessionId, exactOwner } = current;
  if (!sessionId) {
    return noActiveRun();
  }
  if (mode === "cancel") {
    const aborted =
      target === undefined
        ? commands.abortEmbeddedAgentRun(sessionId)
        : exactOwner?.abort() === true;
    const message = aborted
      ? "Cancelled the active OpenClaw run."
      : "OpenClaw could not cancel the active run.";
    return {
      ok: aborted,
      ...controlResultContext,
      sessionId,
      active: true,
      aborted,
      ...(aborted ? {} : { reason: "abort_rejected" }),
      message,
      ...controlResultPresentation,
      ...(aborted ? { providerResult: buildRealtimeVoiceAgentCancelProviderResult(message) } : {}),
    };
  }

  // Steering and follow-up both enqueue to the active run; follow-up is wrapped
  // so the runner treats it as deferred context instead of an immediate pivot.
  const toolAuthorityOverlay = params.getToolAuthorityOverlay?.();
  // Caller preparation can synchronously run host hooks; never retarget a successor.
  const preparedOwner = resolveCurrentRun();
  if (preparedOwner.sessionId !== sessionId || (target && !target.isCurrent(sessionId))) {
    return noActiveRun();
  }
  const steerText = mode === "followup" ? buildRealtimeVoiceAgentFollowupSteeringText(text) : text;
  const options = {
    steeringMode: "all" as const,
    debounceMs: 0,
    isInboundUserMessage: true,
    toolAuthorityOverlay,
    // Talk cannot present task suggestions, so spoken user input must not inherit
    // a capable TUI run's model-facing task tools.
    taskSuggestionDeliveryMode: undefined,
  };
  const outcome: EmbeddedAgentQueueMessageOutcome = target
    ? commands.queueGuardedEmbeddedAgentMessageWithOutcomeAsync
      ? await commands.queueGuardedEmbeddedAgentMessageWithOutcomeAsync(
          sessionId,
          steerText,
          options,
          () => !target.signal.aborted && target.isCurrent(sessionId),
        )
      : {
          queued: false,
          sessionId,
          gatewayHealth: "live",
          reason: "guarded_injection_unsupported",
        }
    : await commands.queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, steerText, options);
  if (!outcome.queued) {
    return {
      ok: false,
      ...controlResultContext,
      sessionId: outcome.sessionId,
      active: true,
      queued: false,
      reason: outcome.reason,
      message: formatRealtimeVoiceAgentQueueRejection(mode, outcome.reason),
      ...controlResultPresentation,
    };
  }

  const unconfirmed = outcome.transcriptCommit === "unconfirmed";
  const message = unconfirmed
    ? "OpenClaw could not confirm that input. It was not sent again; check the conversation before retrying."
    : mode === "followup"
      ? "Queued that follow-up for the active OpenClaw run."
      : "Got it. I steered the active run.";
  return {
    ok: !unconfirmed,
    ...controlResultContext,
    sessionId: outcome.sessionId,
    active: true,
    queued: true,
    target: outcome.target,
    ...(unconfirmed ? { reason: "delivery_unconfirmed" } : {}),
    message,
    ...controlResultPresentation,
    ...(outcome.enqueuedAtMs !== undefined ? { enqueuedAtMs: outcome.enqueuedAtMs } : {}),
    ...(outcome.deliveredAtMs !== undefined ? { deliveredAtMs: outcome.deliveredAtMs } : {}),
  };
}
