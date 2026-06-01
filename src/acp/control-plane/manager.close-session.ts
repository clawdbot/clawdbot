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

export async function runManagerCloseSession(params: {
  input: AcpCloseSessionInput;
  sessionKey: string;
  deps: Pick<AcpSessionManagerDeps, "getRuntimeBackend">;
  runtimeHandles: ManagerRuntimeHandleCache;
  resolveSession: ResolveManagerSession;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  writeSessionMeta: WriteManagerSessionMeta;
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
    params.runtimeHandles.clear(sessionKey);
  } else {
    try {
      const { runtime: ensuredRuntime, handle } = await params.ensureRuntimeHandle({
        cfg: input.cfg,
        sessionKey,
        meta,
      });
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
      params.runtimeHandles.clear(sessionKey);
    } catch (error) {
      const acpError = toAcpRuntimeError({
        error,
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP close failed before completion.",
      });
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

  let metaCleared = false;
  if (input.discardPersistentState && !input.clearMeta) {
    await discardPersistedManagerRuntimeState({
      cfg: input.cfg,
      sessionKey,
      writeSessionMeta: params.writeSessionMeta,
    });
  }

  if (input.clearMeta) {
    await params.writeSessionMeta({
      cfg: input.cfg,
      sessionKey,
      mutate: (_current, entry) => {
        if (!entry) {
          return null;
        }
        return null;
      },
      failOnError: true,
    });
    metaCleared = true;
  }

  return {
    runtimeClosed,
    runtimeNotice,
    metaCleared,
  };
}
