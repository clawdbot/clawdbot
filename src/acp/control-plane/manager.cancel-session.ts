/** Cancellation path for active ACP turns and idle runtime handles. */
import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type AcpRuntimeError,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "../runtime/errors.js";
import type {
  ActiveTurnState,
  EnsureManagerRuntimeHandle,
  ResolveManagerSession,
  SetManagerSessionState,
  WithManagerSessionActor,
} from "./manager.types.js";
import { normalizeActorKey, requireReadySessionMeta } from "./manager.utils.js";

/** Cancels either the active ACP turn or the idle runtime handle for a session. */
export async function runManagerCancelSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  reason?: string;
  activeTurnBySession: Map<string, ActiveTurnState>;
  withSessionActor: WithManagerSessionActor;
  resolveSession: ResolveManagerSession;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  setSessionState: SetManagerSessionState;
}): Promise<void> {
  const actorKey = normalizeActorKey(params.sessionKey);
  const activeTurn = params.activeTurnBySession.get(actorKey);
  if (activeTurn) {
    await cancelActiveTurn({
      activeTurn,
      reason: params.reason,
    });
    return;
  }

  await params.withSessionActor(params.sessionKey, async () => {
    const resolution = params.resolveSession({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    const resolvedMeta = requireReadySessionMeta(resolution);
    const { runtime, handle } = await params.ensureRuntimeHandle({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      meta: resolvedMeta,
    });
    try {
      await cancelRuntimeHandle({
        runtime,
        handle,
        reason: params.reason,
      });
      await params.setSessionState({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        state: "idle",
        clearLastError: true,
      });
    } catch (error) {
      const acpError = normalizeCancelError(error);
      await params.setSessionState({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        state: "error",
        lastError: acpError.message,
      });
      throw acpError;
    }
  });
}

async function cancelActiveTurn(params: {
  activeTurn: ActiveTurnState;
  reason?: string;
}): Promise<void> {
  params.activeTurn.abortController.abort();
  if (!params.activeTurn.cancelPromise) {
    params.activeTurn.cancelPromise = params.activeTurn.runtime.cancel({
      handle: params.activeTurn.handle,
      reason: params.reason,
    });
  }
  await withAcpRuntimeErrorBoundary({
    run: async () => await params.activeTurn.cancelPromise!,
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "ACP cancel failed before completion.",
  });
}

async function cancelRuntimeHandle(params: {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  reason?: string;
}): Promise<void> {
  await withAcpRuntimeErrorBoundary({
    run: async () =>
      await params.runtime.cancel({
        handle: params.handle,
        reason: params.reason,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "ACP cancel failed before completion.",
  });
}

function normalizeCancelError(error: unknown): AcpRuntimeError {
  return toAcpRuntimeError({
    error,
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "ACP cancel failed before completion.",
  });
}
