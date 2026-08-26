/** Cancellation path for active ACP turns and idle runtime handles. */
import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  AcpRuntimeError,
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
  expectedRunId?: string;
  expectedInstanceId?: string;
  expectedOwnerKey?: string;
  activeTurnBySession: Map<string, ActiveTurnState>;
  withSessionActor: WithManagerSessionActor;
  resolveSession: ResolveManagerSession;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  setSessionState: SetManagerSessionState;
}): Promise<void> {
  const actorKey = normalizeActorKey(params.sessionKey);
  const activeTurn = params.activeTurnBySession.get(actorKey);
  const expectedRunId = params.expectedRunId?.trim();
  const expectedInstanceId = params.expectedInstanceId?.trim();
  const expectedOwnerKey = params.expectedOwnerKey?.trim();
  const requireExpectedTurn = (current: ActiveTurnState | undefined) => {
    if (
      (expectedRunId && current?.requestId !== expectedRunId) ||
      (expectedInstanceId && current?.instanceId !== expectedInstanceId)
    ) {
      throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP task is no longer the active run.");
    }
    return current;
  };
  const requireExpectedOwner = () => {
    if (!expectedOwnerKey) {
      return;
    }
    const resolution = params.resolveSession({ cfg: params.cfg, sessionKey: params.sessionKey });
    const entry = resolution.kind === "ready" ? resolution.entry : undefined;
    const ownerKey = entry?.spawnedBy?.trim() || entry?.parentSessionKey?.trim();
    if (ownerKey !== expectedOwnerKey) {
      throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP task owner could not be verified.");
    }
  };
  requireExpectedTurn(activeTurn);
  if (activeTurn) {
    await cancelManagerActiveTurn({
      activeTurn,
      reason: params.reason,
      revalidate: () => {
        requireExpectedTurn(params.activeTurnBySession.get(actorKey));
        requireExpectedOwner();
      },
    });
    return;
  }

  await params.withSessionActor(params.sessionKey, async () => {
    // The actor wait may admit queued work. Recheck exact authority only after
    // that wait, immediately before the idle-handle cancellation boundary.
    requireExpectedTurn(params.activeTurnBySession.get(actorKey));
    requireExpectedOwner();
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

/** Aborts and deduplicates runtime cancellation for one active manager turn. */
export async function cancelManagerActiveTurn(params: {
  activeTurn: ActiveTurnState;
  reason?: string;
  revalidate?: () => void;
}): Promise<void> {
  params.revalidate?.();
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
