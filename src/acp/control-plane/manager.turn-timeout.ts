import type { AcpRuntimeSessionMode } from "@openclaw/acp-core/runtime/types";
import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import type { ActiveTurnState, SessionAcpMeta } from "./manager.types.js";
import { resolveRuntimeOptionsFromMeta } from "./runtime-options.js";

const ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS = 2_000;
const ACP_TURN_TIMEOUT_REASON = "turn-timeout";

export function resolveTurnTimeoutMs(params: {
  cfg: OpenClawConfig;
  meta: SessionAcpMeta;
}): number {
  const runtimeTimeoutSeconds = resolveRuntimeOptionsFromMeta(params.meta).timeoutSeconds;
  if (
    typeof runtimeTimeoutSeconds === "number" &&
    Number.isFinite(runtimeTimeoutSeconds) &&
    runtimeTimeoutSeconds > 0
  ) {
    return clampTimerTimeoutMs(Math.round(runtimeTimeoutSeconds * 1_000), 1_000) ?? 1_000;
  }
  return resolveAgentTimeoutMs({
    cfg: params.cfg,
    minMs: 1_000,
  });
}

export async function awaitTurnWithTimeout<T>(params: {
  sessionKey: string;
  turnPromise: Promise<T>;
  timeoutMs: number;
  timeoutLabelMs: number;
  onTimeout: () => Promise<void>;
}): Promise<T> {
  const observedTurnPromise: Promise<
    | {
        kind: "value";
        value: T;
      }
    | {
        kind: "error";
        error: unknown;
      }
  > = params.turnPromise.then(
    (value) => ({
      kind: "value" as const,
      value,
    }),
    (error: unknown) => ({
      kind: "error" as const,
      error,
    }),
  );

  if (params.timeoutMs <= 0) {
    const outcome = await observedTurnPromise;
    if (outcome.kind === "error") {
      throw outcome.error;
    }
    return outcome.value;
  }

  const timeoutMs = clampTimerTimeoutMs(params.timeoutMs, 1);
  if (timeoutMs === undefined) {
    const outcome = await observedTurnPromise;
    if (outcome.kind === "error") {
      throw outcome.error;
    }
    return outcome.value;
  }

  const timeoutToken = Symbol("acp-turn-timeout");
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<typeof timeoutToken>((resolve) => {
    timer = setTimeout(() => resolve(timeoutToken), timeoutMs);
    timer.unref?.();
  });

  try {
    const outcome = await Promise.race([observedTurnPromise, timeoutPromise]);
    if (outcome === timeoutToken) {
      void observedTurnPromise.then((lateOutcome) => {
        if (lateOutcome.kind === "error") {
          logVerbose(
            `acp-manager: detached late turn error after timeout for ${params.sessionKey}: ${String(lateOutcome.error)}`,
          );
        }
      });
      await params.onTimeout();
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        `ACP turn timed out after ${Math.max(1, Math.round(params.timeoutLabelMs / 1_000))}s.`,
      );
    }
    if (outcome.kind === "error") {
      throw outcome.error;
    }
    return outcome.value;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function cleanupTimedOutTurn(params: {
  sessionKey: string;
  activeTurn: ActiveTurnState;
  mode: AcpRuntimeSessionMode;
  clearCachedRuntimeStateIfHandleMatches: (activeTurn: ActiveTurnState) => void;
}): Promise<void> {
  params.activeTurn.abortController.abort();
  if (!params.activeTurn.cancelPromise) {
    params.activeTurn.cancelPromise = params.activeTurn.runtime.cancel({
      handle: params.activeTurn.handle,
      reason: ACP_TURN_TIMEOUT_REASON,
    });
  }
  const cancelFinished = await awaitCleanupWithGrace({
    sessionKey: params.sessionKey,
    label: "cancel",
    promise: params.activeTurn.cancelPromise,
  });
  if (params.mode !== "oneshot") {
    return;
  }
  const closePromise = params.activeTurn.runtime.close({
    handle: params.activeTurn.handle,
    reason: ACP_TURN_TIMEOUT_REASON,
  });
  const closeFinished = await awaitCleanupWithGrace({
    sessionKey: params.sessionKey,
    label: "close",
    promise: closePromise,
  });
  if (cancelFinished && closeFinished) {
    params.clearCachedRuntimeStateIfHandleMatches(params.activeTurn);
    return;
  }
  void Promise.allSettled([params.activeTurn.cancelPromise, closePromise]).then(() => {
    params.clearCachedRuntimeStateIfHandleMatches(params.activeTurn);
  });
}

async function awaitCleanupWithGrace(params: {
  sessionKey: string;
  label: "cancel" | "close";
  promise: Promise<unknown>;
}): Promise<boolean> {
  const observedCleanupPromise: Promise<
    | {
        kind: "done";
      }
    | {
        kind: "error";
        error: unknown;
      }
  > = params.promise.then(
    () => ({
      kind: "done" as const,
    }),
    (error: unknown) => ({
      kind: "error" as const,
      error,
    }),
  );
  const timeoutToken = Symbol(`acp-timeout-${params.label}`);
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<typeof timeoutToken>((resolve) => {
    timer = setTimeout(() => resolve(timeoutToken), ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS);
    timer.unref?.();
  });

  try {
    const outcome = await Promise.race([observedCleanupPromise, timeoutPromise]);
    if (outcome === timeoutToken) {
      void observedCleanupPromise.then((lateOutcome) => {
        if (lateOutcome.kind === "error") {
          logVerbose(
            `acp-manager: detached timed-out turn ${params.label} cleanup failed for ${params.sessionKey}: ${String(lateOutcome.error)}`,
          );
        }
      });
      logVerbose(
        `acp-manager: timed-out turn ${params.label} cleanup exceeded ${ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS}ms for ${params.sessionKey}`,
      );
      return false;
    }
    if (outcome.kind === "error") {
      logVerbose(
        `acp-manager: timed-out turn ${params.label} cleanup failed for ${params.sessionKey}: ${String(outcome.error)}`,
      );
    }
    return true;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
