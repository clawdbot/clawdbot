/** Command handlers for changing ACP runtime mode and config options on live sessions. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AcpRuntimeError, withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
import { resolveManagerRuntimeCapabilities } from "./manager.runtime-controls.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import type {
  AcpSessionRuntimeOptions,
  EnsureManagerRuntimeHandle,
  ResolveManagerSession,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import { createUnsupportedControlError, requireReadySessionMeta } from "./manager.utils.js";
import {
  inferRuntimeOptionPatchFromConfigOption,
  mergeRuntimeOptions,
  normalizeRuntimeOptions,
  reconcileAcceptedRuntimeOptions,
  resolveRuntimeConfigOptionKey,
  resolveRuntimeOptionsFromMeta,
} from "./runtime-options.js";

/** Manager services required by runtime-option command handlers. */
export type RuntimeOptionCommandServices = {
  runtimeHandles: ManagerRuntimeHandleCache;
  resolveSession: ResolveManagerSession;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  writeSessionMeta: WriteManagerSessionMeta;
};

type RuntimeOptionCommandContext = RuntimeOptionCommandServices & {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
};

/** Applies a backend runtime mode control and persists the selected mode. */
export async function runSetManagerSessionRuntimeMode(
  params: RuntimeOptionCommandContext & { runtimeMode: string },
): Promise<AcpSessionRuntimeOptions> {
  const resolution = params.resolveSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  const resolvedMeta = requireReadySessionMeta(resolution);
  const { runtime, handle, meta } = await params.ensureRuntimeHandle({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    meta: resolvedMeta,
  });
  const capabilities = await resolveManagerRuntimeCapabilities({ runtime, handle });
  if (!capabilities.controls.includes("session/set_mode") || !runtime.setMode) {
    throw createUnsupportedControlError({
      backend: handle.backend || meta.backend,
      control: "session/set_mode",
    });
  }

  await withAcpRuntimeErrorBoundary({
    run: async () =>
      await runtime.setMode!({
        handle,
        mode: params.runtimeMode,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not update ACP runtime mode.",
  });

  const nextOptions = mergeRuntimeOptions({
    current: resolveRuntimeOptionsFromMeta(meta),
    patch: { runtimeMode: params.runtimeMode },
  });
  await persistManagerRuntimeOptions({
    ...params,
    options: nextOptions,
  });
  return nextOptions;
}

/** Applies a backend config-option control and persists the inferred runtime option patch. */
export async function runSetManagerSessionConfigOption(
  params: RuntimeOptionCommandContext & { key: string; value: string },
): Promise<AcpSessionRuntimeOptions> {
  const resolution = params.resolveSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  const resolvedMeta = requireReadySessionMeta(resolution);
  const { runtime, handle, meta } = await params.ensureRuntimeHandle({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    meta: resolvedMeta,
  });
  const inferredPatch = inferRuntimeOptionPatchFromConfigOption(params.key, params.value);
  const capabilities = await resolveManagerRuntimeCapabilities({
    runtime,
    handle,
    includeStatusConfigOptionKeys: true,
  });
  if (!capabilities.controls.includes("session/set_config_option") || !runtime.setConfigOption) {
    throw createUnsupportedControlError({
      backend: handle.backend || meta.backend,
      control: "session/set_config_option",
    });
  }

  const advertisedKeys = new Set(
    (capabilities.configOptionKeys ?? [])
      .map((entry) => normalizeLowercaseStringOrEmpty(entry))
      .filter(Boolean),
  );
  const wireKey = resolveRuntimeConfigOptionKey(params.key, capabilities.configOptionKeys);
  if (advertisedKeys.size > 0 && !advertisedKeys.has(normalizeLowercaseStringOrEmpty(wireKey))) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_UNSUPPORTED_CONTROL",
      `ACP backend "${handle.backend || meta.backend}" does not accept config key "${wireKey}".`,
    );
  }

  const result = await withAcpRuntimeErrorBoundary({
    run: async () =>
      await runtime.setConfigOption!({
        handle,
        key: wireKey,
        value: params.value,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not update ACP runtime config option.",
  });

  const nextOptions = reconcileAcceptedRuntimeOptions(
    mergeRuntimeOptions({ current: resolveRuntimeOptionsFromMeta(meta), patch: inferredPatch }),
    result,
  );
  await persistManagerRuntimeOptions({
    ...params,
    options: nextOptions,
  });
  return nextOptions;
}

/** Persists runtime option changes that do not need an immediate backend control call. */
export async function runUpdateManagerSessionRuntimeOptions(
  params: RuntimeOptionCommandContext & { patch: Partial<AcpSessionRuntimeOptions> },
): Promise<AcpSessionRuntimeOptions> {
  const resolution = params.resolveSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  const resolvedMeta = requireReadySessionMeta(resolution);
  const nextOptions = mergeRuntimeOptions({
    current: resolveRuntimeOptionsFromMeta(resolvedMeta),
    patch: params.patch,
  });
  await persistManagerRuntimeOptions({
    ...params,
    options: nextOptions,
  });
  return nextOptions;
}

/** Closes the current runtime handle and clears persisted runtime options. */
export async function runResetManagerSessionRuntimeOptions(
  params: RuntimeOptionCommandContext,
): Promise<AcpSessionRuntimeOptions> {
  const resolution = params.resolveSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  requireReadySessionMeta(resolution);
  const cached = params.runtimeHandles.get(params);
  if (cached) {
    await withAcpRuntimeErrorBoundary({
      run: async () =>
        await cached.runtime.close({
          handle: cached.handle,
          reason: "reset-runtime-options",
        }),
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "Could not reset ACP runtime options.",
    });
    params.runtimeHandles.clear(params);
  }
  await persistManagerRuntimeOptions({
    ...params,
    options: {},
  });
  return {};
}

async function persistManagerRuntimeOptions(
  params: Pick<
    RuntimeOptionCommandContext,
    "cfg" | "sessionKey" | "agentId" | "runtimeHandles" | "writeSessionMeta"
  > & {
    options: AcpSessionRuntimeOptions;
  },
): Promise<void> {
  const normalized = normalizeRuntimeOptions(params.options);
  const hasOptions = Object.keys(normalized).length > 0;
  await params.writeSessionMeta({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    mutate: (current, entry) => {
      if (!entry || !current) {
        return null;
      }
      return {
        backend: current.backend,
        agent: current.agent,
        runtimeSessionName: current.runtimeSessionName,
        ...(current.identity ? { identity: current.identity } : {}),
        mode: current.mode,
        runtimeOptions: hasOptions ? normalized : undefined,
        cwd: normalized.cwd,
        state: current.state,
        lastActivityAt: Date.now(),
        ...(current.lastError ? { lastError: current.lastError } : {}),
      };
    },
    failOnError: true,
  });

  const cached = params.runtimeHandles.get(params);
  if (!cached) {
    return;
  }
  // Persisting options does not guarantee this process pushed all controls to the runtime.
  // Force the next turn to reconcile runtime controls from persisted metadata.
  cached.appliedControlSignature = undefined;
}
