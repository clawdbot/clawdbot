/**
 * Queues embedded-agent session compaction onto the correct command lane.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  loadSessionEntryReadOnly,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import {
  resolveContextEngine,
  resolveContextEngineOwnerPluginId,
} from "../../context-engine/registry.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type {
  ContextEngine,
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
} from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { resolveUserPath } from "../../utils.js";
import { normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../agent-scope.js";
import { isRecoverableNativeHarnessBindingFailure } from "../harness/compaction-recovery.js";
import { maybeCompactAgentHarnessSession } from "../harness/compaction.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "../prepared-model-runtime.js";
import { resolveAgentRunSessionTarget } from "../run-session-target.js";
import { materializePreparedRuntimeModel } from "../runtime-plan/materialize-model.js";
import type { SandboxContext } from "../sandbox/types.js";
import { resolveSessionPlacementSandbox } from "../session-placement-admission.js";
import { DEFERRED_CONTEXT_ENGINE_COMPACTION_REASON } from "./compact-reasons.js";
import { compactNativeCliSession } from "./compact.js";
import {
  buildContextEngineCompactionSessionTarget,
  executeQueuedContextEngineCompaction,
  type QueuedCompactionHostOptions,
} from "./compact.queued-execution.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import {
  buildEmbeddedCompactionRuntimeContext,
  resolveCompactionContextTokenBudget,
} from "./compaction-runtime-context.js";
import {
  prepareCompactionHarnessAuth,
  resolveCompactionRuntimeSelection,
} from "./compaction-runtime-preparation.js";
import type { acceptCompactionSuccessor } from "./compaction-successor.js";
import { resolveContextEngineCapabilities } from "./context-engine-capabilities.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import { log } from "./logger.js";
import { resolveTieredModel } from "./model-resolution.js";
import { resolveModelAsync } from "./model.js";
import type { EmbeddedAgentQueueHandle } from "./run-state.js";
import {
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunHandleActive,
  resolveActiveEmbeddedRunHandleSessionId,
  resolveActiveEmbeddedRunHandleSessionIdBySessionFile,
  setActiveEmbeddedRun,
} from "./runs.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

type QueuedCompactionParams = CompactEmbeddedAgentSessionParams & {
  sessionTarget: SessionTranscriptRuntimeTarget;
};

function lockedCompactionRuntimeFailure(runtime?: string): EmbeddedAgentCompactResult {
  return {
    ok: false,
    compacted: false,
    reason: runtime
      ? `Model selection is locked to native agent harness "${runtime}", but native compaction is unavailable.`
      : "Model selection is locked but the persisted agent harness is unavailable.",
    failure: { reason: "model_selection_locked" },
  };
}

const DEFERRED_CONTEXT_ENGINE_COMPACTION_SCHEDULE_FAILURE_REASON =
  "failed to schedule background context-engine maintenance";
const MANUAL_COMPACTION_ACTIVE_RUN_REASON =
  "manual compaction unavailable while another embedded run is active";
const COMPACTION_ABORTED_REASON = "compaction aborted";

function createCompactionAbortedResult(): EmbeddedAgentCompactResult {
  return {
    ok: false,
    compacted: false,
    reason: COMPACTION_ABORTED_REASON,
  };
}

function resolveManualCompactionActiveRunSessionId(
  params: CompactEmbeddedAgentSessionParams,
): string | undefined {
  return (
    (isEmbeddedAgentRunHandleActive(params.sessionId) ? params.sessionId : undefined) ??
    (params.sessionKey ? resolveActiveEmbeddedRunHandleSessionId(params.sessionKey) : undefined) ??
    resolveActiveEmbeddedRunHandleSessionIdBySessionFile(params.sessionFile)
  );
}

function shouldDeferOwningContextEngineBudgetCompaction(params: {
  compactParams: CompactEmbeddedAgentSessionParams;
  contextEngine: ContextEngine;
}): boolean {
  // Request-time budget compaction for context-engine-owned transcripts can
  // spend the whole reply preflight budget. Only defer engines that explicitly
  // advertise background turn maintenance, leaving native/current-session
  // harness compaction synchronous.
  return (
    params.compactParams.deferOwningContextEngineCompaction === true &&
    params.compactParams.trigger === "budget" &&
    params.contextEngine.info.ownsCompaction === true &&
    params.contextEngine.info.turnMaintenanceMode === "background" &&
    typeof params.contextEngine.maintain === "function"
  );
}

async function disposeContextEngine(contextEngine: ContextEngine): Promise<void> {
  try {
    await contextEngine.dispose?.();
  } catch (err) {
    log.warn("context engine dispose failed", {
      errorMessage: formatErrorMessage(err),
    });
  }
}

async function deferOwningContextEngineBudgetCompaction(params: {
  compactParams: CompactEmbeddedAgentSessionParams;
  contextEngineSessionKey?: string;
  contextEngine: ContextEngine;
  contextEngineRuntimeContext: ContextEngineRuntimeContext;
  contextEngineRuntimeSettings: ContextEngineRuntimeSettings;
}): Promise<EmbeddedAgentCompactResult> {
  let deferredScheduled = false;
  let deferredScheduleFailure: unknown;
  try {
    await runContextEngineMaintenance({
      contextEngine: params.contextEngine,
      sessionId: params.compactParams.sessionId,
      sessionKey: params.contextEngineSessionKey ?? params.compactParams.sessionKey,
      sessionTarget: buildContextEngineCompactionSessionTarget(params.compactParams),
      sessionFile: params.compactParams.sessionFile,
      reason: "turn",
      runtimeContext: params.contextEngineRuntimeContext,
      runtimeSettings: params.contextEngineRuntimeSettings,
      config: params.compactParams.config,
      contextEngineAgentId: params.compactParams.contextEngineAgentId,
      disposeDeferredContextEngineAfterMaintenance: true,
      onDeferredMaintenance: () => {
        deferredScheduled = true;
      },
      onDeferredMaintenanceFailure: (error) => {
        deferredScheduleFailure = error;
      },
    });
  } catch (err) {
    log.warn("failed to defer context-engine budget compaction", {
      errorMessage: formatErrorMessage(err),
    });
  }

  if (!deferredScheduled || deferredScheduleFailure) {
    log.warn(
      `[compaction] failed to schedule context-engine-owned budget compaction background maintenance ` +
        `(sessionKey=${params.compactParams.sessionKey ?? params.compactParams.sessionId}` +
        `${deferredScheduleFailure ? ` error=${formatErrorMessage(deferredScheduleFailure)}` : ""})`,
    );
    return {
      ok: false,
      compacted: false,
      reason: DEFERRED_CONTEXT_ENGINE_COMPACTION_SCHEDULE_FAILURE_REASON,
      failure: { reason: "deferred_compaction_not_scheduled" },
    };
  }

  log.info(
    `[compaction] deferred context-engine-owned budget compaction to background maintenance ` +
      `(sessionKey=${params.compactParams.sessionKey ?? params.compactParams.sessionId} ` +
      `scheduled=${String(deferredScheduled)})`,
  );
  return {
    ok: true,
    compacted: false,
    reason: DEFERRED_CONTEXT_ENGINE_COMPACTION_REASON,
  };
}

/**
 * Compacts a session with lane queueing (session lane + global lane).
 * Use this from outside a lane context. If already inside a lane, use
 * `compactEmbeddedAgentSessionDirect` to avoid deadlocks.
 */
export async function compactEmbeddedAgentSession(
  params: CompactEmbeddedAgentSessionParams,
  host: QueuedCompactionHostOptions = {},
): Promise<EmbeddedAgentCompactResult> {
  const contextEngineAgentId =
    normalizeOptionalString(params.contextEngineAgentId) ?? normalizeOptionalString(params.agentId);
  const contextEngineSessionKey =
    normalizeOptionalString(params.sessionKey) ??
    normalizeOptionalString(params.sessionTarget?.sessionKey);
  const runtimeTarget = await resolveAgentRunSessionTarget({
    ...params,
    missingSessionKey: "resolve-existing",
  });
  // Resolve the storage address first, then freeze its owner before runtime/plugin awaits.
  const entry = loadSessionEntryReadOnly({ ...runtimeTarget, readConsistency: "latest" });
  const expectedEntry = {
    sessionId: runtimeTarget.sessionId,
    lifecycleRevision: entry?.lifecycleRevision,
    activeWriterRunId: entry?.activeWriterRunId,
  };
  const resolvedParams = {
    ...params,
    ...(params.sessionEntry
      ? { sessionEntry: projectPublicSessionEntry(params.sessionEntry) }
      : {}),
    agentId: runtimeTarget.agentId,
    sessionId: runtimeTarget.sessionId,
    sessionKey: runtimeTarget.sessionKey,
    sessionTarget: runtimeTarget,
    sessionFile: runtimeTarget.sessionKey,
    contextEngineAgentId,
  };
  if (resolvedParams.trigger !== "manual") {
    return await compactEmbeddedAgentSessionImpl(
      resolvedParams,
      expectedEntry,
      host,
      contextEngineSessionKey,
    );
  }
  // Reply operations and embedded handles are separate lifecycle owners. A
  // /compact reply may coexist with this handle, but another embedded writer may not.
  if (resolveManualCompactionActiveRunSessionId(resolvedParams)) {
    return {
      ok: false,
      compacted: false,
      reason: MANUAL_COMPACTION_ACTIVE_RUN_REASON,
      failure: { reason: "active_run" },
    };
  }

  const controller = new AbortController();
  const abortSignal = resolvedParams.abortSignal
    ? AbortSignal.any([resolvedParams.abortSignal, controller.signal])
    : controller.signal;
  const handle: EmbeddedAgentQueueHandle = {
    kind: "embedded",
    queueMessage: async () => {},
    isStreaming: () => true,
    isAborted: () => abortSignal.aborted,
    isCompacting: () => true,
    abort: (reason) => controller.abort(reason ?? "user_abort"),
    cancel: (reason) => controller.abort(reason ?? "user_abort"),
  };
  setActiveEmbeddedRun(
    resolvedParams.sessionId,
    handle,
    resolvedParams.sessionKey,
    resolvedParams.sessionFile,
  );
  try {
    return await compactEmbeddedAgentSessionImpl(
      {
        ...resolvedParams,
        abortSignal,
      },
      expectedEntry,
      host,
      contextEngineSessionKey,
    );
  } finally {
    clearActiveEmbeddedRun(
      resolvedParams.sessionId,
      handle,
      resolvedParams.sessionKey,
      resolvedParams.sessionFile,
    );
  }
}

async function compactEmbeddedAgentSessionImpl(
  params: QueuedCompactionParams,
  expectedEntry: Parameters<typeof acceptCompactionSuccessor>[0]["expectedEntry"],
  host: QueuedCompactionHostOptions,
  contextEngineSessionKey?: string,
): Promise<EmbeddedAgentCompactResult> {
  if (params.abortSignal?.aborted) {
    return createCompactionAbortedResult();
  }
  host.assertActive?.();
  const runtimeTarget = params.sessionTarget;
  const agentIds = resolveSessionAgentIds({
    sessionKey: runtimeTarget.sessionKey,
    config: params.config,
    agentId: runtimeTarget.agentId,
  });
  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, agentIds.sessionAgentId);
  const resolvedWorkspaceDir = resolveUserPath(params.workspaceDir);
  const placementParams = params as CompactEmbeddedAgentSessionParams & {
    sandbox?: SandboxContext | null;
  };
  const placementSandbox =
    placementParams.sandbox === undefined
      ? await resolveSessionPlacementSandbox({
          agentId: runtimeTarget.agentId,
          config: params.config,
          sessionId: runtimeTarget.sessionId,
          sessionKey: runtimeTarget.sessionKey,
          workspaceDir: resolvedWorkspaceDir,
        })
      : null;
  const preparedParams = placementSandbox ? { ...params, sandbox: placementSandbox } : params;
  const runtimeSelection = resolveCompactionRuntimeSelection({
    ...preparedParams,
    modelId: preparedParams.model,
    boundHarnessRuntime: preparedParams.agentHarnessId,
    preparedRuntimePlan: preparedParams.runtimePlan,
    selectedHarnessRuntime:
      preparedParams.modelSelectionLocked === true
        ? normalizeOptionalAgentRuntimeId(preparedParams.agentHarnessId)
        : undefined,
  });
  if (params.abortSignal?.aborted) {
    return createCompactionAbortedResult();
  }
  host.assertActive?.();
  // Native control operations reuse the backend's existing authenticated session.
  // Run them before generic model preparation so subscription-only CLI sessions do
  // not incorrectly require an OpenClaw model API credential.
  const nativeCliResult = await compactNativeCliSession({
    runtime: runtimeSelection.selectedHarnessRuntime,
    compactParams: {
      ...params,
      agentDir,
      workspaceDir: resolvedWorkspaceDir,
    },
  });
  if (nativeCliResult) {
    return nativeCliResult;
  }
  const lease = await acquireAgentRunPreparedModelRuntime({
    config: params.config ?? {},
    agentId: agentIds.sessionAgentId,
    agentDir,
    workspaceDir: resolvedWorkspaceDir,
    ...(params.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
    runtimePluginSelections: [
      {
        provider: runtimeSelection.provider,
        modelId: runtimeSelection.modelId,
        ...(runtimeSelection.selectedHarnessRuntime
          ? { runtime: runtimeSelection.selectedHarnessRuntime }
          : {}),
        agentId: agentIds.sessionAgentId,
      },
    ],
  });
  const run = async () => {
    ensureContextEnginesInitialized();
    const contextEngine = await resolveContextEngine(params.config, {
      agentDir,
      workspaceDir: resolvedWorkspaceDir,
    });
    let disposeContextEngineOnExit = true;
    try {
      // Foreground disposal belongs to this finally. Only accepted background
      // maintenance transfers engine ownership away from this call.
      return await compactResolvedContextEngine(
        preparedParams,
        expectedEntry,
        host,
        contextEngine,
        agentDir,
        resolvedWorkspaceDir,
        lease.snapshot,
        contextEngineSessionKey,
        () => {
          disposeContextEngineOnExit = false;
        },
      );
    } finally {
      if (disposeContextEngineOnExit) {
        await disposeContextEngine(contextEngine);
      }
    }
  };
  try {
    return await withPluginRuntimeGenerationScope(lease.snapshot, run);
  } finally {
    lease.release();
  }
}

async function compactResolvedContextEngine(
  params: QueuedCompactionParams,
  expectedEntry: Parameters<typeof acceptCompactionSuccessor>[0]["expectedEntry"],
  host: QueuedCompactionHostOptions,
  contextEngine: ContextEngine,
  agentDir: string,
  resolvedWorkspaceDir: string,
  preparedModelRuntime: PreparedModelRuntimeSnapshot,
  contextEngineSessionKey: string | undefined,
  releaseContextEngineOwnership: () => void,
): Promise<EmbeddedAgentCompactResult> {
  const runtimeTarget = params.sessionTarget;
  const lockedHarnessRuntime =
    params.modelSelectionLocked === true
      ? normalizeOptionalAgentRuntimeId(params.agentHarnessId)
      : undefined;
  if (
    params.modelSelectionLocked === true &&
    (!lockedHarnessRuntime || lockedHarnessRuntime === "auto")
  ) {
    return lockedCompactionRuntimeFailure();
  }
  // A model lock makes the persisted harness authoritative. Config may select
  // a runtime only for unlocked sessions that have no concrete pin.
  const {
    runtimePolicySessionKey,
    runtimePolicyAgentId,
    selectedHarnessRuntime,
    target: resolvedCompactionTarget,
    runtimeModelAuth: { plan: reusableRuntimeAuthPlan, modelAuth: initialModelAuth },
    provider: ceProvider,
    runtimeProvider: ceRuntimeProvider,
    contextConfigProvider: ceContextConfigProvider,
    modelId: ceModelId,
    attemptNativeHarnessCompaction,
  } = resolveCompactionRuntimeSelection({
    ...params,
    modelId: params.model,
    boundHarnessRuntime: params.agentHarnessId,
    preparedRuntimePlan: params.runtimePlan,
    selectedHarnessRuntime: params.modelSelectionLocked === true ? lockedHarnessRuntime : undefined,
  });
  const lockedNativeHarness =
    params.modelSelectionLocked === true && selectedHarnessRuntime !== "openclaw";
  // Ensure the policy-selected harness plugin so selection can pick implicit codex.
  await ensureSelectedAgentHarnessPlugin({
    config: params.config,
    provider: ceProvider,
    modelId: ceModelId,
    agentId: runtimePolicyAgentId,
    sessionKey: runtimePolicySessionKey,
    agentHarnessId: params.agentHarnessId,
    agentHarnessRuntimeOverride: selectedHarnessRuntime,
    workspaceDir: resolvedWorkspaceDir,
    pluginRegistry: requireActivePluginRegistry(),
  });
  const { resolution: modelResolution } = await resolveTieredModel({
    provider: ceRuntimeProvider,
    modelId: ceModelId,
    agentDir,
    config: params.config,
    workspaceDir: resolvedWorkspaceDir,
    ...initialModelAuth,
    preparedModelRuntime,
  });
  const { model: ceModel, authStorage, modelRegistry } = modelResolution;
  const ceRuntimeModel = ceModel as ProviderRuntimeModel | undefined;
  // Overrides stay unset when no bound/planned/explicit harness resolved so auth-aware
  // selection can pick the credential-owning harness (codex for ChatGPT OAuth).
  const {
    runtimeAuthPreparation,
    selectedPreparedHarness,
    providerUsesProfileScopedModelMetadata,
  } = await prepareCompactionHarnessAuth({
    ...params,
    provider: ceProvider,
    metadataProvider: ceRuntimeProvider,
    modelId: ceModelId,
    model: ceRuntimeModel,
    reusableRuntimeAuthPlan,
    agentDir,
    workspaceDir: resolvedWorkspaceDir,
    authProfileId: resolvedCompactionTarget.authProfileId,
    runtimePolicyAgentId,
    runtimePolicySessionKey,
    agentHarnessRuntimeOverride: selectedHarnessRuntime,
    convergenceErrorPrefix: "Prepared queued compaction",
  });
  const preparedHarnessRuntime = selectedPreparedHarness.id;
  const runtimeAuthPlan = runtimeAuthPreparation.plan;
  const effectiveRuntimeModel = await materializePreparedRuntimeModel<ProviderRuntimeModel>({
    plan: runtimeAuthPlan,
    provider: ceProvider,
    modelId: ceModelId,
    config: params.config,
    model: ceRuntimeModel,
    forceResolve:
      providerUsesProfileScopedModelMetadata && Boolean(runtimeAuthPlan.selectedAuthMode),
    resolveModel: async ({ config, authProfileId, authProfileMode }) => {
      const resolved = await resolveModelAsync(ceRuntimeProvider, ceModelId, agentDir, config, {
        authStorage,
        modelRegistry,
        preparedModelRuntime,
        skipAgentDiscovery: true,
        allowBundledStaticCatalogFallback: true,
        preferBundledStaticCatalogTransport: true,
        workspaceDir: resolvedWorkspaceDir,
        authProfileId,
        authProfileMode,
      });
      return { ...resolved, model: resolved.model as ProviderRuntimeModel | undefined };
    },
  });
  const preparedParams: QueuedCompactionParams = {
    ...params,
    provider: ceProvider,
    model: ceModelId,
    agentHarnessId: preparedHarnessRuntime,
    ...(reusableRuntimeAuthPlan
      ? {
          authProfileId: runtimeAuthPlan.forwardedAuthProfileId,
          authProfileIdSource: runtimeAuthPlan.forwardedAuthProfileSource,
          runtimeAuthPlan,
        }
      : {
          // Native compaction resolves this full attempt set itself. Legacy
          // compaction must re-plan too; forwarding one generated plan would
          // collapse cross-route and direct fallback before either dispatch.
          authProfileId: resolvedCompactionTarget.authProfileId,
          authProfileIdSource: resolvedCompactionTarget.authProfileId
            ? params.authProfileIdSource
            : undefined,
          runtimeAuthPlan: undefined,
          runtimePlan: undefined,
        }),
  };
  const contextTokenBudget = resolveCompactionContextTokenBudget({
    config: params.config,
    provider: ceContextConfigProvider,
    modelId: ceModelId,
    model: effectiveRuntimeModel,
    agentId: runtimeTarget.agentId,
    requestedTokenBudget: params.contextTokenBudget,
  });
  const contextEngineRuntimeContext = buildCompactionContextEngineRuntimeContext({
    params: preparedParams,
    agentDir,
    harnessRuntime: preparedHarnessRuntime,
    contextEngineSessionKey,
    contextTokenBudget,
    contextEnginePluginId: resolveContextEngineOwnerPluginId(contextEngine),
  });
  const contextEngineRuntimeSettings = buildContextEngineRuntimeSettings({
    contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
    provider: ceProvider,
    requestedModel: params.model,
    resolvedModel: ceModelId,
    selectedContextEngineId: contextEngine.info.id,
    contextEngineSelectionSource: contextEngine.info.id === "legacy" ? "default" : "configured",
    promptTokenBudget: contextTokenBudget,
  });
  if (params.abortSignal?.aborted) {
    return createCompactionAbortedResult();
  }
  host.assertActive?.();
  const contextEngineOwnsCompaction = contextEngine.info.ownsCompaction === true;
  let requiredPreflightNativeCapabilityUsed = false;
  const harnessResult =
    attemptNativeHarnessCompaction && (!contextEngineOwnsCompaction || lockedNativeHarness)
      ? await maybeCompactAgentHarnessSession(
          {
            ...preparedParams,
            runtimeModel: effectiveRuntimeModel,
            contextEngine,
            contextTokenBudget,
            contextEngineRuntimeContext,
          },
          {
            preparedModelRuntime,
            ...(preparedParams.preflightRequired === true
              ? {
                  nativeCompactionRequest: "required_preflight",
                  onNativeCompactionCapabilityUsed: () => {
                    requiredPreflightNativeCapabilityUsed = true;
                  },
                }
              : {}),
          },
        )
      : undefined;
  // Only the private dispatched native capability may authorize required-preflight
  // fallback for a locked harness; public result fields cannot escape the lock.
  if (
    lockedNativeHarness &&
    !(
      preparedParams.preflightRequired === true &&
      requiredPreflightNativeCapabilityUsed &&
      isRecoverableNativeHarnessBindingFailure(harnessResult)
    )
  ) {
    return harnessResult ?? lockedCompactionRuntimeFailure(selectedHarnessRuntime);
  }
  if (harnessResult) {
    if (!isRecoverableNativeHarnessBindingFailure(harnessResult)) {
      return { ...harnessResult, compactionKind: "native-harness" };
    }
    log.warn(
      `native harness compaction could not use its session binding; falling back to context engine: ${harnessResult.reason ?? "unknown"}`,
    );
  }
  if (params.abortSignal?.aborted) {
    return createCompactionAbortedResult();
  }
  host.assertActive?.();
  if (
    shouldDeferOwningContextEngineBudgetCompaction({
      compactParams: preparedParams,
      contextEngine,
    })
  ) {
    const deferredResult = await deferOwningContextEngineBudgetCompaction({
      compactParams: preparedParams,
      contextEngineSessionKey,
      contextEngine,
      contextEngineRuntimeContext,
      contextEngineRuntimeSettings,
    });
    if (deferredResult.ok) {
      releaseContextEngineOwnership();
    }
    return deferredResult;
  }
  return await executeQueuedContextEngineCompaction({
    params,
    preparedParams,
    runtimeTarget,
    expectedEntry,
    host,
    contextEngine,
    contextEngineSessionKey,
    contextEngineRuntimeContext,
    contextEngineRuntimeSettings,
    resolvedWorkspaceDir,
    preparedModelRuntime,
    effectiveRuntimeModel,
    preparedHarnessRuntime,
    contextTokenBudget,
    attemptNativeHarnessCompaction,
  });
}

function buildCompactionContextEngineRuntimeContext(params: {
  params: CompactEmbeddedAgentSessionParams;
  agentDir: string;
  contextEngineSessionKey?: string;
  harnessRuntime?: string;
  contextEnginePluginId?: string;
  contextTokenBudget?: number;
}): ContextEngineRuntimeContext {
  const { sessionFile: _sessionFile, contextEngineAgentId, ...runtimeParams } = params.params;
  return {
    ...runtimeParams,
    sessionTarget: buildContextEngineCompactionSessionTarget(params.params),
    ...buildEmbeddedCompactionRuntimeContext({
      ...params.params,
      agentDir: params.agentDir,
      modelId: params.params.model,
      harnessRuntime: params.harnessRuntime,
    }),
    ...resolveContextEngineCapabilities({
      config: params.params.config,
      sessionKey: params.contextEngineSessionKey ?? params.params.sessionKey,
      explicitAgentId: contextEngineAgentId,
      authProfileId: params.params.authProfileId,
      contextEnginePluginId: params.contextEnginePluginId,
      purpose: "context-engine.compaction",
    }),
    tokenBudget: params.contextTokenBudget,
    currentTokenCount: params.params.currentTokenCount,
  };
}
