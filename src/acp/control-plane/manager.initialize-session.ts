import {
  createIdentityFromEnsure,
  mergeSessionIdentity,
} from "@openclaw/acp-core/runtime/session-identity";
import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import { resolveRuntimeConfigCacheKey } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { AcpRuntimeError, withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import type {
  AcpInitializeSessionInput,
  AcpSessionManagerDeps,
  SessionAcpMeta,
  SessionEntry,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import {
  normalizeRuntimeOptions,
  normalizeText,
  validateRuntimeOptionPatch,
} from "./runtime-options.js";

export async function runManagerInitializeSession(params: {
  input: AcpInitializeSessionInput;
  sessionKey: string;
  deps: Pick<AcpSessionManagerDeps, "requireRuntimeBackend">;
  runtimeHandles: ManagerRuntimeHandleCache;
  enforceConcurrentSessionLimit: (params: { cfg: OpenClawConfig; sessionKey: string }) => void;
  writeSessionMeta: WriteManagerSessionMeta;
}): Promise<{
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  meta: SessionAcpMeta;
}> {
  const { input, sessionKey } = params;
  const backend = params.deps.requireRuntimeBackend(input.backendId || input.cfg.acp?.backend);
  const runtime = backend.runtime;
  const agent = normalizeAgentId(input.agent);
  const initialRuntimeOptions = validateRuntimeOptionPatch({
    ...input.runtimeOptions,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  });
  const requestedCwd = initialRuntimeOptions.cwd;
  const requestedModel = initialRuntimeOptions.model;
  const requestedThinking = initialRuntimeOptions.thinking;
  params.enforceConcurrentSessionLimit({
    cfg: input.cfg,
    sessionKey,
  });
  const handle = await withAcpRuntimeErrorBoundary({
    run: async () =>
      await runtime.ensureSession({
        sessionKey,
        agent,
        mode: input.mode,
        resumeSessionId: input.resumeSessionId,
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(requestedThinking ? { thinking: requestedThinking } : {}),
        cwd: requestedCwd,
      }),
    fallbackCode: "ACP_SESSION_INIT_FAILED",
    fallbackMessage: "Could not initialize ACP session runtime.",
  });
  const effectiveCwd = normalizeText(handle.cwd) ?? requestedCwd;
  const effectiveRuntimeOptions = normalizeRuntimeOptions({
    ...initialRuntimeOptions,
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
  });

  const identityNow = Date.now();
  const initializedIdentity =
    mergeSessionIdentity({
      current: undefined,
      incoming: createIdentityFromEnsure({
        handle,
        now: identityNow,
      }),
      now: identityNow,
    }) ??
    ({
      state: "pending",
      source: "ensure",
      lastUpdatedAt: identityNow,
    } as const);
  const meta: SessionAcpMeta = {
    backend: handle.backend || backend.id,
    agent,
    runtimeSessionName: handle.runtimeSessionName,
    identity: initializedIdentity,
    mode: input.mode,
    ...(Object.keys(effectiveRuntimeOptions).length > 0
      ? { runtimeOptions: effectiveRuntimeOptions }
      : {}),
    cwd: effectiveCwd,
    state: "idle",
    lastActivityAt: Date.now(),
  };

  const persisted = await persistInitializedSessionMeta({
    cfg: input.cfg,
    sessionKey,
    meta,
    runtime,
    handle,
    writeSessionMeta: params.writeSessionMeta,
  });
  if (!persisted?.acp) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      `Could not persist ACP metadata for ${sessionKey}.`,
    );
  }
  params.runtimeHandles.set(sessionKey, {
    runtime,
    handle,
    backend: handle.backend || backend.id,
    agent,
    mode: input.mode,
    cwd: effectiveCwd,
    configSignature: resolveRuntimeConfigCacheKey(input.cfg),
  });
  return {
    runtime,
    handle,
    meta,
  };
}

async function persistInitializedSessionMeta(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  meta: SessionAcpMeta;
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  writeSessionMeta: WriteManagerSessionMeta;
}): Promise<SessionEntry | null> {
  try {
    const persisted = await params.writeSessionMeta({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      mutate: () => params.meta,
      failOnError: true,
    });
    if (persisted?.acp) {
      return persisted;
    }
  } catch (error) {
    await closeRuntimeAfterInitMetaFailure(params);
    throw error;
  }

  await closeRuntimeAfterInitMetaFailure(params);
  return null;
}

async function closeRuntimeAfterInitMetaFailure(params: {
  sessionKey: string;
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
}): Promise<void> {
  await params.runtime
    .close({
      handle: params.handle,
      reason: "init-meta-failed",
    })
    .catch((closeError: unknown) => {
      logVerbose(
        `acp-manager: cleanup close failed after metadata write error for ${params.sessionKey}: ${String(closeError)}`,
      );
    });
}
