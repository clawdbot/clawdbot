/** Ensures or recreates a live ACP runtime handle for persisted session metadata. */
import {
  createIdentityFromEnsure,
  identityEquals,
  identityHasStableSessionId,
  mergeSessionIdentity,
  resolveRuntimeHandleIdentifiersFromIdentity,
  resolveRuntimeResumeSessionId,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import { resolveRuntimeConfigCacheKey } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { toAcpRuntimeError, withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import type {
  AcpSessionManagerDeps,
  SessionAcpMeta,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import { hasLegacyAcpIdentityProjection, resolveAcpAgentFromSessionKey } from "./manager.utils.js";
import {
  normalizeRuntimeOptions,
  normalizeText,
  resolveRuntimeOptionsFromMeta,
  runtimeOptionsEqual,
} from "./runtime-options.js";

/** Returns a reusable cached handle or initializes a fresh runtime session for the metadata. */
export async function ensureManagerRuntimeHandle(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  meta: SessionAcpMeta;
  deps: Pick<AcpSessionManagerDeps, "requireRuntimeBackend">;
  runtimeHandles: ManagerRuntimeHandleCache;
  enforceConcurrentSessionLimit: (params: { cfg: OpenClawConfig; sessionKey: string }) => void;
  writeSessionMeta: WriteManagerSessionMeta;
}): Promise<{ runtime: AcpRuntime; handle: AcpRuntimeHandle; meta: SessionAcpMeta }> {
  const agent =
    normalizeText(params.meta.agent) || resolveAcpAgentFromSessionKey(params.sessionKey, "main");
  const mode = params.meta.mode;
  const runtimeOptions = resolveRuntimeOptionsFromMeta(params.meta);
  const cwd = runtimeOptions.cwd ?? normalizeText(params.meta.cwd);
  const model = normalizeText(runtimeOptions.model);
  const thinking = normalizeText(runtimeOptions.thinking);
  const configuredBackend = (params.meta.backend || params.cfg.acp?.backend || "").trim();
  const configSignature = resolveRuntimeConfigCacheKey(params.cfg);
  const cached = params.runtimeHandles.get(params.sessionKey);
  if (cached) {
    const backendMatches = !configuredBackend || cached.backend === configuredBackend;
    const agentMatches = cached.agent === agent;
    const modeMatches = cached.mode === mode;
    const cwdMatches = (cached.cwd ?? "") === (cwd ?? "");
    const configMatches = cached.configSignature === configSignature;
    const handleMatchesMeta = params.runtimeHandles.handleMatchesMeta({
      handle: cached.handle,
      meta: params.meta,
    });
    if (
      backendMatches &&
      agentMatches &&
      modeMatches &&
      cwdMatches &&
      configMatches &&
      handleMatchesMeta &&
      (await params.runtimeHandles.isReusable({
        sessionKey: params.sessionKey,
        runtime: cached.runtime,
        handle: cached.handle,
      }))
    ) {
      return {
        runtime: cached.runtime,
        handle: cached.handle,
        meta: params.meta,
      };
    }
    await params.runtimeHandles.close({
      sessionKey: params.sessionKey,
      reason: "runtime-handle-replaced",
    });
  }

  params.enforceConcurrentSessionLimit({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });

  const backend = params.deps.requireRuntimeBackend(configuredBackend || undefined);
  const runtime = backend.runtime;
  const previousMeta = params.meta;
  const previousIdentity = resolveSessionIdentityFromMeta(previousMeta);
  let identityForEnsure = previousIdentity;
  const persistedResumeSessionId =
    mode === "persistent" ? resolveRuntimeResumeSessionId(previousIdentity) : undefined;
  const shouldPrepareFreshPersistentSession =
    mode === "persistent" &&
    previousIdentity != null &&
    !identityHasStableSessionId(previousIdentity);
  const ensureSession = async (resumeSessionId?: string) =>
    await withAcpRuntimeErrorBoundary({
      run: async () =>
        await runtime.ensureSession({
          sessionKey: params.sessionKey,
          agent,
          mode,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
          cwd,
        }),
      fallbackCode: "ACP_SESSION_INIT_FAILED",
      fallbackMessage: "Could not initialize ACP session runtime.",
    });
  let ensured: AcpRuntimeHandle;
  if (shouldPrepareFreshPersistentSession) {
    await runtime.prepareFreshSession?.({
      sessionKey: params.sessionKey,
    });
  }
  if (persistedResumeSessionId) {
    try {
      ensured = await ensureSession(persistedResumeSessionId);
    } catch (error) {
      const acpError = toAcpRuntimeError({
        error,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Could not initialize ACP session runtime.",
      });
      if (acpError.code !== "ACP_SESSION_INIT_FAILED") {
        throw acpError;
      }
      logVerbose(
        `acp-manager: resume init failed for ${params.sessionKey}; retrying without persisted ACP session id: ${acpError.message}`,
      );
      if (identityForEnsure) {
        const {
          acpxSessionId: _staleAcpxSessionId,
          agentSessionId: _staleAgentSessionId,
          ...retryIdentity
        } = identityForEnsure;
        // The persisted resume identifiers already failed, so do not merge them back into the
        // fresh named-session handle returned by the retry path.
        identityForEnsure = {
          ...retryIdentity,
          state: "pending",
        };
      }
      ensured = await ensureSession();
    }
  } else {
    ensured = await ensureSession();
  }

  const now = Date.now();
  const effectiveCwd = normalizeText(ensured.cwd) ?? cwd;
  const nextRuntimeOptions = normalizeRuntimeOptions({
    ...runtimeOptions,
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
  });
  const nextIdentity =
    mergeSessionIdentity({
      current: identityForEnsure,
      incoming: createIdentityFromEnsure({
        handle: ensured,
        now,
      }),
      now,
    }) ?? identityForEnsure;
  const nextHandleIdentifiers = resolveRuntimeHandleIdentifiersFromIdentity(nextIdentity);
  const nextHandle: AcpRuntimeHandle = {
    ...ensured,
    ...(nextHandleIdentifiers.backendSessionId
      ? { backendSessionId: nextHandleIdentifiers.backendSessionId }
      : {}),
    ...(nextHandleIdentifiers.agentSessionId
      ? { agentSessionId: nextHandleIdentifiers.agentSessionId }
      : {}),
  };
  const nextMeta: SessionAcpMeta = {
    backend: ensured.backend || backend.id,
    agent,
    runtimeSessionName: ensured.runtimeSessionName,
    ...(nextIdentity ? { identity: nextIdentity } : {}),
    mode: params.meta.mode,
    ...(Object.keys(nextRuntimeOptions).length > 0 ? { runtimeOptions: nextRuntimeOptions } : {}),
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
    state: previousMeta.state,
    lastActivityAt: now,
    ...(previousMeta.lastError ? { lastError: previousMeta.lastError } : {}),
  };
  const shouldPersistMeta =
    previousMeta.backend !== nextMeta.backend ||
    previousMeta.runtimeSessionName !== nextMeta.runtimeSessionName ||
    !identityEquals(previousIdentity, nextIdentity) ||
    previousMeta.agent !== nextMeta.agent ||
    previousMeta.cwd !== nextMeta.cwd ||
    !runtimeOptionsEqual(previousMeta.runtimeOptions, nextMeta.runtimeOptions) ||
    hasLegacyAcpIdentityProjection(previousMeta);
  if (shouldPersistMeta) {
    await params.writeSessionMeta({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      mutate: (_current, entry) => {
        if (!entry) {
          return null;
        }
        return nextMeta;
      },
    });
  }
  params.runtimeHandles.set(params.sessionKey, {
    runtime,
    handle: nextHandle,
    backend: ensured.backend || backend.id,
    agent,
    mode,
    cwd: effectiveCwd,
    configSignature,
    appliedControlSignature: undefined,
  });
  return {
    runtime,
    handle: nextHandle,
    meta: nextMeta,
  };
}
