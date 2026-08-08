/** Close/reset path for ACP runtime sessions and persisted manager metadata. */
import {
  identityHasStableSessionId,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import { toAcpRuntimeError, withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import {
  discardPersistedManagerRuntimeState,
  isRecoverableManagerAcpxExitError,
  tryPrepareFreshManagerRuntimeSession,
} from "./manager.runtime-resume-state.js";
import type {
  AcpCloseSessionInput,
  AcpCloseSessionResult,
  AcpSessionManagerDeps,
  EnsureManagerRuntimeHandle,
  ResolveManagerSession,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import { requireReadySessionMeta, resolveAcpSessionResolutionError } from "./manager.utils.js";

/** Closes an ACP session runtime handle and optionally discards persistent state/meta. */
export async function runManagerCloseSession(params: {
  input: AcpCloseSessionInput;
  sessionKey: string;
  deps: Pick<AcpSessionManagerDeps, "getRuntimeBackend">;
  runtimeHandles: ManagerRuntimeHandleCache;
  resolveSession: ResolveManagerSession;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  writeSessionMeta: WriteManagerSessionMeta;
  isCurrentActor: () => boolean;
}): Promise<AcpCloseSessionResult> {
  const { input, sessionKey } = params;
  const resolution = params.resolveSession({
    cfg: input.cfg,
    sessionKey,
  });
  const resolutionError = resolveAcpSessionResolutionError(resolution);
  if (resolutionError) {
    if (input.requireAcpSession ?? true) {
      throw resolutionError;
    }
    return {
      runtimeClosed: false,
      metaCleared: false,
    };
  }
  const meta = requireReadySessionMeta(resolution);
  const currentIdentity = resolveSessionIdentityFromMeta(meta);
  const shouldSkipRuntimeClose =
    input.discardPersistentState &&
    currentIdentity != null &&
    !identityHasStableSessionId(currentIdentity);

  let runtimeClosed = false;
  let runtimeNotice: string | undefined;
  if (shouldSkipRuntimeClose) {
    await tryPrepareFreshManagerRuntimeSession({
      deps: params.deps,
      cfg: input.cfg,
      meta,
      sessionKey,
      logPrefix: "acp close fast-reset",
    });
    if (!params.isCurrentActor()) {
      return {
        runtimeClosed: false,
        metaCleared: false,
      };
    }
    params.runtimeHandles.clear(sessionKey);
  } else {
    try {
      const { runtime: ensuredRuntime, handle } = await params.ensureRuntimeHandle({
        cfg: input.cfg,
        sessionKey,
        meta,
        isCurrentActor: params.isCurrentActor,
      });
      if (input.discardPersistentState) {
        // A discard close may itself hang. Evict before awaiting it so reset
        // callers can never reuse the handle after their cleanup timeout.
        params.runtimeHandles.clearIfHandleMatches({ sessionKey, handle });
      }
      await withAcpRuntimeErrorBoundary({
        run: async () =>
          await ensuredRuntime.close({
            handle,
            reason: input.reason,
            discardPersistentState: input.discardPersistentState,
          }),
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP close failed before completion.",
      });
      runtimeClosed = true;
      if (!params.isCurrentActor()) {
        return {
          runtimeClosed,
          metaCleared: false,
        };
      }
      if (!input.discardPersistentState) {
        params.runtimeHandles.clearIfHandleMatches({ sessionKey, handle });
      }
    } catch (error) {
      const acpError = toAcpRuntimeError({
        error,
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP close failed before completion.",
      });
      if (!params.isCurrentActor()) {
        throw acpError;
      }
      if (
        input.allowBackendUnavailable &&
        (acpError.code === "ACP_BACKEND_MISSING" ||
          acpError.code === "ACP_BACKEND_UNAVAILABLE" ||
          (input.discardPersistentState && acpError.code === "ACP_SESSION_INIT_FAILED") ||
          (input.discardPersistentState && acpError.code === "ACP_BACKEND_UNSUPPORTED_CONTROL") ||
          isRecoverableManagerAcpxExitError(acpError.message))
      ) {
        if (input.discardPersistentState) {
          await tryPrepareFreshManagerRuntimeSession({
            deps: params.deps,
            cfg: input.cfg,
            meta,
            sessionKey,
            logPrefix: "acp close recovery",
            missingBackendError: acpError,
          });
          if (!params.isCurrentActor()) {
            throw acpError;
          }
        }
        // Treat unavailable backends as terminal for this cached handle so it
        // cannot continue counting against maxConcurrentSessions.
        params.runtimeHandles.clear(sessionKey);
        runtimeNotice = acpError.message;
      } else {
        throw acpError;
      }
    }
  }

  if (!params.isCurrentActor()) {
    return {
      runtimeClosed,
      ...(runtimeNotice ? { runtimeNotice } : {}),
      metaCleared: false,
    };
  }

  let metaCleared = false;
  if (input.discardPersistentState && !input.clearMeta) {
    await discardPersistedManagerRuntimeState({
      cfg: input.cfg,
      sessionKey,
      writeSessionMeta: params.writeSessionMeta,
      isCurrentActor: params.isCurrentActor,
    });
  }

  if (input.clearMeta) {
    await params.writeSessionMeta({
      cfg: input.cfg,
      sessionKey,
      isCurrentActor: params.isCurrentActor,
      mutate: (_current, entry) => {
        if (!params.isCurrentActor()) {
          return undefined;
        }
        if (!entry) {
          return null;
        }
        return null;
      },
      failOnError: true,
    });
    if (!params.isCurrentActor()) {
      return {
        runtimeClosed,
        ...(runtimeNotice ? { runtimeNotice } : {}),
        metaCleared: false,
      };
    }
    metaCleared = true;
  }

  return {
    runtimeClosed,
    runtimeNotice,
    metaCleared,
  };
}
