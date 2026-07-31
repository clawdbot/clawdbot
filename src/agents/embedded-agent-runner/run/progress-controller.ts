import {
  FAST_MODE_AUTO_PROGRESS_KIND,
  type ReplyPayload,
} from "../../../auto-reply/reply-payload.js";
import { emitAgentItemEvent } from "../../../infra/agent-activity-events.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { resolveFastModeModelAutoOnSeconds } from "../../../shared/fast-mode.js";
import {
  type FastModeAutoProgressState,
  formatFastModeAutoProgressText,
  resolveFastModeForElapsed,
} from "../../fast-mode.js";
import { log } from "../logger.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import type { EmbeddedRunFastModeParam } from "./types.js";

export function createEmbeddedRunProgressController(params: {
  attempt: RunEmbeddedAgentParams;
  noteLaneTaskProgress: () => void;
  startedAtMs: number;
}) {
  const fastModeStartedAtMs = params.attempt.fastModeStartedAtMs ?? params.startedAtMs;
  // Embedded callers may set only `fastMode: "auto"`; preserve the selected
  // model's cutoff instead of silently falling back to the global default.
  const fastModeAutoOnSeconds =
    params.attempt.fastModeAutoOnSeconds ??
    resolveFastModeModelAutoOnSeconds({
      cfg: params.attempt.config,
      provider: params.attempt.provider,
      model: params.attempt.model,
    });
  const fastModeAutoProgressState: FastModeAutoProgressState = params.attempt
    .fastModeAutoProgressState ?? {
    offAnnounced: false,
    resetAnnounced: false,
  };
  const notifyExecutionPhase = (
    phase: Parameters<NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>>[0]["phase"],
    extra?: Omit<Parameters<NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>>[0], "phase">,
  ) => {
    params.noteLaneTaskProgress();
    params.attempt.onExecutionPhase?.({ phase, ...extra });
  };
  const notifyRunProgress = (
    info: Parameters<NonNullable<RunEmbeddedAgentParams["onRunProgress"]>>[0],
  ) => {
    params.noteLaneTaskProgress();
    params.attempt.onRunProgress?.(info);
  };
  const emitFastModeAutoProgress = async (payload: {
    enabled: boolean;
    elapsedSeconds: number;
    fastAutoOnSeconds?: number;
  }) => {
    const summary = formatFastModeAutoProgressText(payload);
    try {
      emitAgentItemEvent({
        runId: params.attempt.runId,
        ...(params.attempt.sessionKey ? { sessionKey: params.attempt.sessionKey } : {}),
        data: {
          itemId: `fast-mode-auto:${payload.enabled ? "on" : "off"}`,
          kind: "status",
          title: "Fast",
          phase: "update",
          status: "running",
          summary,
        },
      });
    } catch (error) {
      log.debug(`embedded run fast mode auto global event failed: ${formatErrorMessage(error)}`);
    }
    try {
      await params.attempt.onAgentEvent?.({
        stream: "item",
        data: {
          kind: "status",
          title: "Fast",
          phase: "update",
          summary,
        },
        ...(params.attempt.sessionKey ? { sessionKey: params.attempt.sessionKey } : {}),
      });
    } catch (error) {
      log.debug(`embedded run fast mode auto event failed: ${formatErrorMessage(error)}`);
    }
    try {
      await params.attempt.onToolResult?.({
        text: summary,
        channelData: { openclawProgressKind: FAST_MODE_AUTO_PROGRESS_KIND },
      });
    } catch (error) {
      log.debug(`embedded run fast mode auto progress failed: ${formatErrorMessage(error)}`);
    }
  };
  const maybeAnnounceFastModeAutoOff = async () => {
    if (params.attempt.fastMode !== "auto" || fastModeAutoProgressState.offAnnounced) {
      return;
    }
    const next = resolveFastModeForElapsed({
      mode: "auto",
      startedAtMs: fastModeStartedAtMs,
      fastAutoOnSeconds: fastModeAutoOnSeconds,
    });
    if (next.enabled) {
      return;
    }
    fastModeAutoProgressState.offAnnounced = true;
    await emitFastModeAutoProgress(next);
  };
  const notifyToolResult = async (payload: ReplyPayload) => {
    await params.attempt.onToolResult?.(payload);
  };
  const notifyAgentEvent = async (
    event: Parameters<NonNullable<RunEmbeddedAgentParams["onAgentEvent"]>>[0],
  ) => {
    await params.attempt.onAgentEvent?.(event);
  };
  const resolveAttemptFastMode = (): boolean | undefined => {
    const resolved = resolveFastModeForElapsed({
      mode: params.attempt.fastMode,
      startedAtMs: fastModeStartedAtMs,
      fastAutoOnSeconds: fastModeAutoOnSeconds,
    });
    return resolved.mode === undefined ? undefined : resolved.enabled;
  };
  const resolveAttemptFastModeParam = (): EmbeddedRunFastModeParam | undefined => {
    if (params.attempt.fastMode === "auto") {
      return resolveAttemptFastMode;
    }
    return resolveAttemptFastMode();
  };
  const maybeEmitFastModeAutoReset = async () => {
    if (
      params.attempt.fastMode !== "auto" ||
      !fastModeAutoProgressState.offAnnounced ||
      fastModeAutoProgressState.resetAnnounced
    ) {
      return;
    }
    fastModeAutoProgressState.resetAnnounced = true;
    await emitFastModeAutoProgress({
      enabled: true,
      elapsedSeconds: 0,
      fastAutoOnSeconds: fastModeAutoOnSeconds,
    });
  };
  const maybeEmitFastModeAutoResetBestEffort = async () => {
    try {
      await maybeEmitFastModeAutoReset();
    } catch (error) {
      log.warn(`embedded run fast mode auto reset progress failed: ${formatErrorMessage(error)}`);
    }
  };

  return {
    fastModeAutoOnSeconds,
    fastModeAutoProgressState,
    fastModeStartedAtMs,
    maybeAnnounceFastModeAutoOff,
    maybeEmitFastModeAutoResetBestEffort,
    notifyAgentEvent,
    notifyExecutionPhase,
    notifyRunProgress,
    notifyToolResult,
    resolveAttemptFastModeParam,
  };
}
