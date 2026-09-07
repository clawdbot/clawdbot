/** Session initialization path for ACP runtime handles and persisted manager metadata. */
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
import {
  assertAcpRuntimeOwnerSupport,
  persistedAcpRuntimeHandle,
} from "./manager.runtime-owner.js";
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

/** Initializes an ACP runtime session and persists its metadata before caching the handle. */
export async function runManagerInitializeSession(params: {
  input: AcpInitializeSessionInput;
  sessionKey: string;
  agentId: string;
  deps: Pick<AcpSessionManagerDeps, "requireRuntimeBackend" | "loadSessionEntry">;
  runtimeHandles: ManagerRuntimeHandleCache;
  writeSessionMeta: WriteManagerSessionMeta;
}): Promise<{
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  meta: SessionAcpMeta;
  sessionEntry: SessionEntry;
}> {
  const { input, sessionKey, agentId } = params;
  const backend = params.deps.requireRuntimeBackend(input.backendId || input.cfg.acp?.backend);
  const runtime = backend.runtime;
  assertAcpRuntimeOwnerSupport(runtime, params);
  const agent = normalizeAgentId(input.agent);
  const initialRuntimeOptions = validateRuntimeOptionPatch({
    ...input.runtimeOptions,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  });
  const requestedCwd = initialRuntimeOptions.cwd;
  const requestedModel = initialRuntimeOptions.model;
  const requestedThinking = initialRuntimeOptions.thinking;
  const previousMeta = params.deps.loadSessionEntry({ cfg: input.cfg, sessionKey, agentId })?.acp;
  input.assertActive?.();
  const ensured = await withAcpRuntimeErrorBoundary({
    run: async () =>
      await runtime.ensureSession({
        sessionKey,
        agentId,
        persistedHandle:
          previousMeta?.backend === backend.id
            ? persistedAcpRuntimeHandle(params, previousMeta)
            : undefined,
        agent,
        mode: input.mode,
        resumeSessionId: input.resumeSessionId,
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(requestedModel && input.modelExplicit ? { modelExplicit: true } : {}),
        ...(requestedThinking ? { thinking: requestedThinking } : {}),
        cwd: requestedCwd,
      }),
    fallbackCode: "ACP_SESSION_INIT_FAILED",
    fallbackMessage: "Could not initialize ACP session runtime.",
  });
  const handle = { ...ensured, agentId, sessionKey };
  const effectiveCwd = normalizeText(handle.cwd) ?? requestedCwd;
  const effectiveRuntimeOptions = normalizeRuntimeOptions({
    ...initialRuntimeOptions,
    model: handle.appliedModel
      ? handle.appliedModel.kind === "applied"
        ? handle.appliedModel.model
        : undefined
      : requestedModel,
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
    agentId,
    meta,
    runtime,
    handle,
    writeSessionMeta: params.writeSessionMeta,
    assertCommitAllowed: input.assertActive,
  });
  if (!persisted?.acp) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      `Could not persist ACP metadata for ${sessionKey}.`,
    );
  }
  params.runtimeHandles.set(params, {
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
    sessionEntry: persisted,
  };
}

async function persistInitializedSessionMeta(params: {
  assertCommitAllowed?: () => void;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  meta: SessionAcpMeta;
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  writeSessionMeta: WriteManagerSessionMeta;
}): Promise<SessionEntry | null> {
  try {
    const persisted = await params.writeSessionMeta({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      mutate: () => params.meta,
      failOnError: true,
      assertCommitAllowed: params.assertCommitAllowed,
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
  agentId: string;
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
