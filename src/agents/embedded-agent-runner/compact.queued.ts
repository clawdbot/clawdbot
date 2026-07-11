/**
 * Queues embedded-agent session compaction onto the correct command lane.
 */
import { parseSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import {
  resolveContextEngine,
  resolveContextEngineOwnerPluginId,
} from "../../context-engine/registry.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import {
  resolveCompactionSuccessorTranscript,
  type ContextEngine,
  type ContextEngineRuntimeContext,
  type ContextEngineRuntimeSettings,
  type ContextEngineSessionTarget,
} from "../../context-engine/types.js";
import {
  createFileBackedCompactionCheckpointStore,
  readSessionLeafStateFromTranscriptAsync,
  resolveCompactionCheckpointTranscriptPosition,
  resolveSessionCompactionCheckpointReason,
  type CapturedCompactionCheckpointSnapshot,
} from "../../gateway/session-compaction-checkpoints.js";
import { mergeAbortSignals } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../agent-scope.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { isRecoverableNativeHarnessBindingFailure } from "../harness/compaction-recovery.js";
import { maybeCompactAgentHarnessSession } from "../harness/compaction.js";
import { resolveAgentHarnessPolicy } from "../harness/policy.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import {
  selectAgentHarness,
  selectAgentHarnessForPreparedModelProviders,
  type AgentHarnessPreparedModelProvider,
} from "../harness/selection.js";
import {
  resolveAgentHarnessPreparedAuthSupport,
  resolveAgentHarnessPreparedRouteSupport,
} from "../harness/support.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
} from "../model-auth.js";
import { isOpenAIProvider } from "../openai-routing.js";
import { resolveAgentRunSessionTarget } from "../run-session-target.js";
import { materializePreparedRuntimeModel } from "../runtime-plan/materialize-model.js";
import {
  agentRuntimeAuthPlanMatchesTarget,
  prepareAgentRuntimeAuth,
  type PreparedAgentRuntimeAuthAttempt,
} from "../runtime-plan/prepare-auth.js";
import type { AgentRuntimeAuthPlan } from "../runtime-plan/types.js";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import { SessionManager } from "../sessions/index.js";
import { DEFERRED_CONTEXT_ENGINE_COMPACTION_REASON } from "./compact-reasons.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import { asCompactionHookRunner, runPostCompactionSideEffects } from "./compaction-hooks.js";
import {
  buildEmbeddedCompactionRuntimeContext,
  resolveCompactionHarnessRuntime,
  resolveEmbeddedCompactionTarget,
} from "./compaction-runtime-context.js";
import {
  compactContextEngineWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./compaction-safety-timeout.js";
import {
  rotateTranscriptFileAfterCompaction,
  shouldRotateCompactionTranscript,
} from "./compaction-successor-transcript.js";
import { resolveContextEngineCapabilities } from "./context-engine-capabilities.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { readAgentModelContextTokens } from "./model-context-tokens.js";
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
import { normalizeContextTokenBudget } from "./utils.js";

const compactionCheckpointStore = createFileBackedCompactionCheckpointStore();

function shouldFallbackAfterHarnessCompaction(
  result: EmbeddedAgentCompactResult | undefined,
): boolean {
  return isRecoverableNativeHarnessBindingFailure(result);
}

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

function buildQueuedCompactionHarnessModelProvider(params: {
  model?: ProviderRuntimeModel;
  plan?: AgentRuntimeAuthPlan;
  attempt?: PreparedAgentRuntimeAuthAttempt;
}): AgentHarnessPreparedModelProvider {
  const route = params.plan?.modelRoute;
  return {
    api: route?.api ?? params.model?.api,
    baseUrl: route?.baseUrl ?? params.model?.baseUrl,
    ...resolveAgentHarnessPreparedRouteSupport(params.plan),
    ...(params.plan
      ? {
          preparedAuth: resolveAgentHarnessPreparedAuthSupport({
            plan: params.plan,
            source: params.attempt?.kind === "implicit" ? undefined : params.attempt?.kind,
          }),
        }
      : {}),
  };
}

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

function buildContextEngineCompactionSessionTarget(
  params: CompactEmbeddedAgentSessionParams,
): ContextEngineSessionTarget {
  const sqliteMarker = parseSqliteSessionFileMarker(params.sessionFile);
  const agentId = params.sessionTarget?.agentId ?? params.agentId ?? sqliteMarker?.agentId;
  const sessionKey = params.sessionTarget?.sessionKey ?? params.sessionKey ?? params.sessionId;
  const storePath = params.sessionTarget?.storePath ?? sqliteMarker?.storePath;
  return {
    ...(agentId ? { agentId } : {}),
    sessionId: params.sessionTarget?.sessionId ?? sqliteMarker?.sessionId ?? params.sessionId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(storePath ? { storePath } : {}),
    ...(params.sessionTarget?.threadId !== undefined
      ? { threadId: params.sessionTarget.threadId }
      : {}),
  };
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
      sessionKey: params.compactParams.sessionKey,
      sessionTarget: buildContextEngineCompactionSessionTarget(params.compactParams),
      sessionFile: params.compactParams.sessionFile,
      reason: "turn",
      runtimeContext: params.contextEngineRuntimeContext,
      runtimeSettings: params.contextEngineRuntimeSettings,
      config: params.compactParams.config,
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

function mergeSecondaryNativeHarnessCompactionDetails(params: {
  details: unknown;
  nativeResult: EmbeddedAgentCompactResult | undefined;
  detailsKey: "codexNativeCompaction" | "nativeHarnessCompaction";
}): unknown {
  if (!params.nativeResult) {
    return params.details;
  }
  if (params.details && typeof params.details === "object" && !Array.isArray(params.details)) {
    return {
      ...(params.details as Record<string, unknown>),
      [params.detailsKey]: params.nativeResult,
    };
  }
  if (params.details !== undefined) {
    return {
      contextEngine: params.details,
      [params.detailsKey]: params.nativeResult,
    };
  }
  return {
    [params.detailsKey]: params.nativeResult,
  };
}

/**
 * Compacts a session with lane queueing (session lane + global lane).
 * Use this from outside a lane context. If already inside a lane, use
 * `compactEmbeddedAgentSessionDirect` to avoid deadlocks.
 */
export async function compactEmbeddedAgentSession(
  params: CompactEmbeddedAgentSessionParams,
): Promise<EmbeddedAgentCompactResult> {
  if (params.trigger !== "manual") {
    return await compactEmbeddedAgentSessionImpl(params);
  }
  // Reply operations and embedded handles are separate lifecycle owners. A
  // /compact reply may coexist with this handle, but another embedded writer may not.
  if (resolveManualCompactionActiveRunSessionId(params)) {
    return {
      ok: false,
      compacted: false,
      reason: MANUAL_COMPACTION_ACTIVE_RUN_REASON,
      failure: { reason: "active_run" },
    };
  }

  const controller = new AbortController();
  const mergedAbort = mergeAbortSignals([params.abortSignal, controller.signal]);
  const handle: EmbeddedAgentQueueHandle = {
    kind: "embedded",
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => true,
    abort: (reason) => controller.abort(reason ?? "user_abort"),
    cancel: (reason) => controller.abort(reason ?? "user_abort"),
  };
  setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
  try {
    return await compactEmbeddedAgentSessionImpl({
      ...params,
      abortSignal: mergedAbort.signal,
    });
  } finally {
    mergedAbort.dispose();
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
  }
}

async function compactEmbeddedAgentSessionImpl(
  params: CompactEmbeddedAgentSessionParams,
): Promise<EmbeddedAgentCompactResult> {
  if (params.abortSignal?.aborted) {
    return createCompactionAbortedResult();
  }
  ensureRuntimePluginsLoaded({
    config: params.config,
    workspaceDir: params.workspaceDir,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
  });
  ensureContextEnginesInitialized();
  const agentIds = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, agentIds.sessionAgentId);
  const resolvedWorkspaceDir = resolveUserPath(params.workspaceDir);
  const contextEngine = await resolveContextEngine(params.config, {
    agentDir,
    workspaceDir: resolvedWorkspaceDir,
  });
  let disposeContextEngineOnExit = true;
  try {
    // Retain engine ownership until the queued path settles. Explicit cleanup
    // or accepted background maintenance may release it from this call.
    return await compactResolvedContextEngine(
      params,
      contextEngine,
      agentDir,
      resolvedWorkspaceDir,
      () => {
        disposeContextEngineOnExit = false;
      },
    );
  } finally {
    if (disposeContextEngineOnExit) {
      await disposeContextEngine(contextEngine);
    }
  }
}

async function compactResolvedContextEngine(
  params: CompactEmbeddedAgentSessionParams,
  contextEngine: ContextEngine,
  agentDir: string,
  resolvedWorkspaceDir: string,
  releaseContextEngineOwnership: () => void,
): Promise<EmbeddedAgentCompactResult> {
  const runtimePolicySessionKey = params.sandboxSessionKey ?? params.sessionKey;
  const runtimePolicyAgentId =
    params.sandboxSessionKey && parseAgentSessionKey(params.sandboxSessionKey)
      ? undefined
      : params.agentId;
  const policyCompactionTarget = resolveEmbeddedCompactionTarget({
    config: params.config,
    provider: params.provider,
    modelId: params.model,
    authProfileId: params.authProfileId,
    modelSelectionLocked: params.modelSelectionLocked,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const policyProvider = policyCompactionTarget.provider ?? DEFAULT_PROVIDER;
  const policyModelId = policyCompactionTarget.model ?? DEFAULT_MODEL;
  const configuredHarnessPolicy = resolveAgentHarnessPolicy({
    provider: policyProvider,
    modelId: policyModelId,
    config: params.config,
    agentId: runtimePolicyAgentId,
    sessionKey: runtimePolicySessionKey,
  });
  const configuredHarnessRuntime =
    configuredHarnessPolicy.runtimeSource &&
    configuredHarnessPolicy.runtimeSource !== "implicit" &&
    !isDefaultAgentRuntimeId(configuredHarnessPolicy.runtime)
      ? configuredHarnessPolicy.runtime
      : undefined;
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
  const selectedHarnessRuntime =
    params.modelSelectionLocked === true
      ? lockedHarnessRuntime
      : resolveCompactionHarnessRuntime({
          boundHarnessRuntime: params.agentHarnessId,
          preparedRuntimePlan: params.runtimePlan,
          configuredHarnessRuntime,
          provider: policyProvider,
          modelId: policyModelId,
        });
  const lockedNativeHarness =
    params.modelSelectionLocked === true && selectedHarnessRuntime !== "openclaw";
  const resolvedCompactionTarget = resolveEmbeddedCompactionTarget({
    config: params.config,
    provider: params.provider,
    modelId: params.model,
    authProfileId: params.authProfileId,
    harnessRuntime: selectedHarnessRuntime,
    modelSelectionLocked: params.modelSelectionLocked,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const ceProvider = resolvedCompactionTarget.provider ?? DEFAULT_PROVIDER;
  const ceRuntimeProvider = resolvedCompactionTarget.runtimeProvider ?? ceProvider;
  const ceContextConfigProvider = resolvedCompactionTarget.contextProvider ?? ceProvider;
  const ceModelId = resolvedCompactionTarget.model ?? DEFAULT_MODEL;
  const attemptNativeHarnessCompaction = shouldAttemptNativeHarnessCompaction({
    provider: ceProvider,
    nativeHarnessCompaction: resolvedCompactionTarget.nativeHarnessCompaction,
    selectedHarnessRuntime,
  });
  let effectiveRuntimeModel: ProviderRuntimeModel | undefined;
  let preparedHarnessRuntime = selectedHarnessRuntime;
  let preparedParams = params;
  try {
    if (attemptNativeHarnessCompaction) {
      await ensureSelectedAgentHarnessPlugin({
        config: params.config,
        provider: ceProvider,
        modelId: ceModelId,
        agentId: runtimePolicyAgentId,
        sessionKey: runtimePolicySessionKey,
        agentHarnessId: params.agentHarnessId,
        agentHarnessRuntimeOverride: selectedHarnessRuntime,
        workspaceDir: resolvedWorkspaceDir,
      });
    }
    const {
      model: ceModel,
      authStorage,
      modelRegistry,
    } = await resolveModelAsync(ceRuntimeProvider, ceModelId, agentDir, params.config);
    const ceRuntimeModel = ceModel as ProviderRuntimeModel | undefined;
    const providedRuntimeAuthPlan = params.runtimeAuthPlan ?? params.runtimePlan?.auth;
    const runtimeAuthProfileStore = isOpenAIProvider(ceProvider)
      ? ensureAuthProfileStore(agentDir, {
          externalCliProviderIds: ["openai"],
          allowKeychainPrompt: false,
        })
      : ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
          allowKeychainPrompt: false,
        });
    const reusableRuntimeAuthPlan =
      providedRuntimeAuthPlan &&
      agentRuntimeAuthPlanMatchesTarget(providedRuntimeAuthPlan, {
        provider: ceProvider,
        modelId: ceModelId,
      })
        ? providedRuntimeAuthPlan
        : undefined;
    const compactionHarnessRuntimeOverride = selectedHarnessRuntime ?? "openclaw";
    const selectHarnessForPreparedAttempts = (
      attempts: readonly PreparedAgentRuntimeAuthAttempt[],
    ) =>
      selectAgentHarnessForPreparedModelProviders({
        provider: ceProvider,
        modelId: ceModelId,
        modelProviders: attempts.map((attempt) =>
          buildQueuedCompactionHarnessModelProvider({
            model: ceRuntimeModel,
            plan: attempt.plan,
            attempt,
          }),
        ),
        config: params.config,
        agentId: runtimePolicyAgentId,
        sessionKey: runtimePolicySessionKey,
        agentHarnessId: params.agentHarnessId,
        agentHarnessRuntimeOverride: compactionHarnessRuntimeOverride,
      });
    const initialHarness = reusableRuntimeAuthPlan
      ? undefined
      : selectAgentHarness({
          provider: ceProvider,
          modelId: ceModelId,
          modelProvider: buildQueuedCompactionHarnessModelProvider({ model: ceRuntimeModel }),
          config: params.config,
          agentId: runtimePolicyAgentId,
          sessionKey: runtimePolicySessionKey,
          agentHarnessId: params.agentHarnessId,
          agentHarnessRuntimeOverride: compactionHarnessRuntimeOverride,
        });
    const prepareRuntimeAuth = (harness: ReturnType<typeof selectAgentHarness>) =>
      prepareAgentRuntimeAuth({
        provider: ceProvider,
        modelId: ceModelId,
        modelApi: ceRuntimeModel?.api,
        modelBaseUrl: ceRuntimeModel?.baseUrl,
        config: params.config,
        env: process.env,
        agentDir,
        workspaceDir: resolvedWorkspaceDir,
        authProfileStore: runtimeAuthProfileStore,
        sessionAuthProfileId: resolvedCompactionTarget.authProfileId,
        sessionAuthProfileSource: params.authProfileIdSource,
        harnessId: harness.id,
        harnessRuntime: harness.id,
        harnessAuthBootstrap: harness.authBootstrap,
      });
    let runtimeAuthPreparation = reusableRuntimeAuthPlan
      ? {
          plan: reusableRuntimeAuthPlan,
          attempts: [{ kind: "implicit" as const, plan: reusableRuntimeAuthPlan }],
        }
      : prepareRuntimeAuth(initialHarness!);
    let selectedPreparedHarness = selectHarnessForPreparedAttempts(runtimeAuthPreparation.attempts);
    if (!reusableRuntimeAuthPlan && selectedPreparedHarness.id !== initialHarness?.id) {
      runtimeAuthPreparation = prepareRuntimeAuth(selectedPreparedHarness);
      const confirmedHarness = selectHarnessForPreparedAttempts(runtimeAuthPreparation.attempts);
      if (confirmedHarness.id !== selectedPreparedHarness.id) {
        throw new Error(
          `Prepared queued compaction auth routes did not converge on one agent harness for ${ceProvider}/${ceModelId}.`,
        );
      }
      selectedPreparedHarness = confirmedHarness;
    }
    preparedHarnessRuntime = selectedPreparedHarness.id;
    const runtimeAuthPlan = runtimeAuthPreparation.plan;
    effectiveRuntimeModel = await materializePreparedRuntimeModel<ProviderRuntimeModel>({
      plan: runtimeAuthPlan,
      provider: ceProvider,
      modelId: ceModelId,
      config: params.config,
      model: ceRuntimeModel,
      resolveModel: async ({ config, authProfileId, authProfileMode }) => {
        const resolved = await resolveModelAsync(ceRuntimeProvider, ceModelId, agentDir, config, {
          authStorage,
          modelRegistry,
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
    preparedParams = {
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
  } catch (err) {
    await disposeContextEngine(contextEngine);
    releaseContextEngineOwnership();
    throw err;
  }
  const resolvedContextTokenBudget =
    normalizeContextTokenBudget(
      resolveContextWindowInfo({
        cfg: params.config,
        provider: ceContextConfigProvider,
        modelId: ceModelId,
        modelContextTokens: readAgentModelContextTokens(effectiveRuntimeModel),
        modelContextWindow: effectiveRuntimeModel?.contextWindow,
        defaultTokens: DEFAULT_CONTEXT_TOKENS,
      }).tokens,
    ) ?? DEFAULT_CONTEXT_TOKENS;
  const requestedContextTokenBudget = normalizeContextTokenBudget(params.contextTokenBudget);
  const contextTokenBudget = Math.min(
    requestedContextTokenBudget ?? resolvedContextTokenBudget,
    resolvedContextTokenBudget,
  );
  const contextEngineRuntimeContext = buildCompactionContextEngineRuntimeContext({
    params: preparedParams,
    agentDir,
    harnessRuntime: preparedHarnessRuntime,
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
  const contextEngineOwnsCompaction = contextEngine.info.ownsCompaction === true;
  const harnessResult =
    attemptNativeHarnessCompaction && (!contextEngineOwnsCompaction || lockedNativeHarness)
      ? await maybeCompactAgentHarnessSession({
          ...preparedParams,
          runtimeModel: effectiveRuntimeModel,
          contextEngine,
          contextTokenBudget,
          contextEngineRuntimeContext,
        })
      : undefined;
  if (lockedNativeHarness) {
    return harnessResult ?? lockedCompactionRuntimeFailure(selectedHarnessRuntime);
  }
  if (harnessResult) {
    if (!shouldFallbackAfterHarnessCompaction(harnessResult)) {
      return harnessResult;
    }
    log.warn(
      `native harness compaction could not use its session binding; falling back to context engine: ${harnessResult.reason ?? "unknown"}`,
    );
  }
  if (
    shouldDeferOwningContextEngineBudgetCompaction({
      compactParams: preparedParams,
      contextEngine,
    })
  ) {
    const deferredResult = await deferOwningContextEngineBudgetCompaction({
      compactParams: preparedParams,
      contextEngine,
      contextEngineRuntimeContext,
      contextEngineRuntimeSettings,
    });
    if (deferredResult.ok) {
      releaseContextEngineOwnership();
    }
    return deferredResult;
  }
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  return await enqueueCommandInLane(sessionLane, () =>
    enqueueGlobal(async () => {
      let checkpointSnapshot: CapturedCompactionCheckpointSnapshot | null | undefined;
      let checkpointSnapshotRetained = false;
      try {
        if (params.abortSignal?.aborted) {
          return createCompactionAbortedResult();
        }
        // When the context engine owns compaction, its compact() implementation
        // bypasses compactEmbeddedAgentSessionDirect (which fires the hooks internally).
        // Fire before_compaction / after_compaction hooks here so plugin subscribers
        // are notified regardless of which engine is active.
        const engineOwnsCompaction = contextEngine.info.ownsCompaction === true;
        const isSqliteSessionTranscript = Boolean(parseSqliteSessionFileMarker(params.sessionFile));
        checkpointSnapshot = engineOwnsCompaction
          ? await compactionCheckpointStore.captureSnapshot({
              sessionFile: params.sessionFile,
              ...(isSqliteSessionTranscript
                ? { sessionManager: SessionManager.open(params.sessionFile) }
                : {}),
            })
          : null;
        const hookRunner = engineOwnsCompaction
          ? asCompactionHookRunner(getGlobalHookRunner())
          : null;
        const hookSessionKey = params.sessionKey?.trim() || params.sessionId;
        const { sessionAgentId } = resolveSessionAgentIds({
          sessionKey: params.sessionKey,
          config: params.config,
          agentId: params.agentId,
        });
        const resolvedMessageProvider = params.messageChannel ?? params.messageProvider;
        const hookCtx = {
          sessionId: params.sessionId,
          agentId: sessionAgentId,
          sessionKey: hookSessionKey,
          workspaceDir: resolvedWorkspaceDir,
          messageProvider: resolvedMessageProvider,
        };
        const runtimeContext = contextEngineRuntimeContext;
        // Engine-owned compaction doesn't load the transcript at this level, so
        // message counts are unavailable. We pass sessionFile so hook subscribers
        // can read the transcript themselves if they need exact counts.
        if (hookRunner?.hasHooks?.("before_compaction") && hookRunner.runBeforeCompaction) {
          try {
            await hookRunner.runBeforeCompaction(
              {
                messageCount: -1,
                sessionFile: params.sessionFile,
              },
              hookCtx,
            );
          } catch (err) {
            log.warn("before_compaction hook failed", {
              errorMessage: formatErrorMessage(err),
            });
          }
        }
        // Bound the plugin-owned compaction with the same finite safety
        // timeout that protects native runtime compaction, and thread the
        // caller's abort signal through, so a slow/hung plugin compact()
        // cannot hang the queued /compact lane indefinitely. A timeout/abort
        // (or any thrown error) is surfaced as a clean { ok: false } result —
        // matching how the run-loop overflow/timeout lanes handle it — instead
        // of throwing a raw rejection at callers that only inspect result.ok.
        let result: Awaited<ReturnType<typeof contextEngine.compact>>;
        try {
          const compactionSessionTarget = buildContextEngineCompactionSessionTarget(params);
          result = await compactContextEngineWithSafetyTimeout(
            contextEngine,
            {
              sessionId: params.sessionId,
              sessionKey: hookSessionKey,
              ...(compactionSessionTarget.agentId
                ? { agentId: compactionSessionTarget.agentId }
                : {}),
              sessionTarget: compactionSessionTarget,
              tokenBudget: contextTokenBudget,
              currentTokenCount: params.currentTokenCount,
              compactionTarget: params.trigger === "manual" ? "threshold" : "budget",
              customInstructions: params.customInstructions,
              force:
                params.force === true ||
                params.forcePreflight === true ||
                params.preflightRequired === true ||
                params.trigger === "manual",
              runtimeContext: {
                ...runtimeContext,
                forceReason:
                  params.forcePreflight === true || params.preflightRequired === true
                    ? "preflight_required"
                    : params.trigger === "manual"
                      ? "manual"
                      : undefined,
                preflightCompactionTrigger: params.preflightCompactionTrigger,
              },
              runtimeSettings: contextEngineRuntimeSettings,
            },
            resolveCompactionTimeoutMs(params.config),
            params.abortSignal,
          );
        } catch (compactErr) {
          log.warn("context-engine compaction failed", {
            errorMessage: formatErrorMessage(compactErr),
          });
          result = {
            ok: false,
            compacted: false,
            reason: formatErrorMessage(compactErr),
          };
        }
        const delegatedSuccessor = resolveCompactionSuccessorTranscript(result);
        const delegatedSessionTarget = result.result?.sessionTarget;
        const delegatedSessionId = delegatedSuccessor.sessionId;
        const delegatedSessionFile = delegatedSuccessor.sessionFile;
        const delegatedRotatedTranscript =
          (typeof delegatedSessionId === "string" && delegatedSessionId !== params.sessionId) ||
          (typeof delegatedSessionFile === "string" && delegatedSessionFile !== params.sessionFile);
        let postCompactionSessionId = delegatedSessionId ?? params.sessionId;
        // Shipped pre-sessionTarget engines report rotation via the deprecated
        // sessionFile field; honor it when no typed target is present.
        let postCompactionSessionFile = delegatedSessionFile ?? params.sessionFile;
        if (delegatedSessionTarget) {
          const resolvedDelegatedTarget = await resolveAgentRunSessionTarget({
            agentId: delegatedSessionTarget.agentId ?? sessionAgentId,
            config: params.config,
            sessionId: delegatedSessionTarget.sessionId ?? postCompactionSessionId,
            sessionKey: delegatedSessionTarget.sessionKey ?? params.sessionKey,
            sessionTarget: delegatedSessionTarget,
          });
          postCompactionSessionId = resolvedDelegatedTarget.sessionId;
          postCompactionSessionFile = resolvedDelegatedTarget.sessionFile;
        }
        let postCompactionLeafId: string | undefined;
        if (result.ok && result.compacted) {
          if (
            shouldRotateCompactionTranscript(params.config) &&
            !delegatedRotatedTranscript &&
            !isSqliteSessionTranscript
          ) {
            try {
              const rotation = await rotateTranscriptFileAfterCompaction({
                sessionFile: params.sessionFile,
              });
              if (rotation.rotated) {
                postCompactionSessionId = rotation.sessionId ?? postCompactionSessionId;
                postCompactionSessionFile = rotation.sessionFile ?? postCompactionSessionFile;
                postCompactionLeafId = rotation.leafId;
                log.info(
                  `[compaction] rotated active transcript after context-engine compaction ` +
                    `(sessionKey=${params.sessionKey ?? params.sessionId})`,
                );
              }
            } catch (err) {
              log.warn("failed to rotate compacted transcript", {
                errorMessage: formatErrorMessage(err),
              });
            }
          }
          if (params.config && params.sessionKey && checkpointSnapshot) {
            try {
              const transcriptState =
                await readSessionLeafStateFromTranscriptAsync(postCompactionSessionFile);
              const checkpointPosition = resolveCompactionCheckpointTranscriptPosition({
                preferredLeafId: postCompactionLeafId,
                transcriptState,
              });
              const storedCheckpoint = await compactionCheckpointStore.persistCheckpoint({
                cfg: params.config,
                sessionKey: params.sessionKey,
                sessionId: postCompactionSessionId,
                reason: resolveSessionCompactionCheckpointReason({
                  trigger: params.trigger,
                }),
                snapshot: checkpointSnapshot,
                summary: result.result?.summary,
                firstKeptEntryId: result.result?.firstKeptEntryId,
                tokensBefore: result.result?.tokensBefore,
                tokensAfter: result.result?.tokensAfter,
                postSessionFile: postCompactionSessionFile,
                postLeafId: checkpointPosition.leafId,
                postEntryId: checkpointPosition.entryId,
              });
              checkpointSnapshotRetained = storedCheckpoint !== null;
            } catch (err) {
              log.warn("failed to persist compaction checkpoint", {
                errorMessage: formatErrorMessage(err),
              });
            }
          }
          await runContextEngineMaintenance({
            contextEngine,
            sessionId: postCompactionSessionId,
            sessionKey: params.sessionKey,
            sessionTarget: buildContextEngineCompactionSessionTarget({
              ...params,
              sessionFile: postCompactionSessionFile,
              sessionId: postCompactionSessionId,
              sessionTarget: delegatedSessionTarget ?? params.sessionTarget,
            }),
            sessionFile: postCompactionSessionFile,
            reason: "compaction",
            runtimeContext,
            runtimeSettings: contextEngineRuntimeSettings,
            config: params.config,
          });
        }
        if (engineOwnsCompaction && result.ok && result.compacted) {
          await runPostCompactionSideEffects({
            config: params.config,
            sessionKey: params.sessionKey,
            sessionId: postCompactionSessionId,
            agentId: sessionAgentId,
            sessionFile: postCompactionSessionFile,
          });
        }
        if (
          result.ok &&
          result.compacted &&
          hookRunner?.hasHooks?.("after_compaction") &&
          hookRunner.runAfterCompaction
        ) {
          try {
            const afterHookCtx = {
              ...hookCtx,
              sessionId: postCompactionSessionId,
            };
            await hookRunner.runAfterCompaction(
              {
                messageCount: -1,
                compactedCount: -1,
                tokenCount: result.result?.tokensAfter,
                sessionFile: postCompactionSessionFile,
                ...(postCompactionSessionId !== params.sessionId
                  ? { previousSessionId: params.sessionId }
                  : {}),
              },
              afterHookCtx,
            );
          } catch (err) {
            log.warn("after_compaction hook failed", {
              errorMessage: formatErrorMessage(err),
            });
          }
        }
        let secondaryNativeHarnessCompaction: EmbeddedAgentCompactResult | undefined;
        if (
          engineOwnsCompaction &&
          result.ok &&
          result.compacted &&
          attemptNativeHarnessCompaction
        ) {
          try {
            // The native bridge owns its terminal-event watchdog. Keep this lane held until
            // that bridge settles; an outer timeout would release transcript ownership while
            // the harness could still be compacting the same session.
            secondaryNativeHarnessCompaction = await maybeCompactAgentHarnessSession(
              {
                ...preparedParams,
                sessionId: postCompactionSessionId,
                sessionFile: postCompactionSessionFile,
                runtimeModel: effectiveRuntimeModel,
                contextEngine,
                contextTokenBudget,
                contextEngineRuntimeContext,
              },
              { nativeCompactionRequest: "after_context_engine" },
            );
            if (secondaryNativeHarnessCompaction && !secondaryNativeHarnessCompaction.ok) {
              log.warn(
                "secondary native harness compaction failed after context-engine compaction",
                {
                  reason: secondaryNativeHarnessCompaction.reason,
                },
              );
            }
          } catch (err) {
            secondaryNativeHarnessCompaction = {
              ok: false,
              compacted: false,
              reason: formatErrorMessage(err),
            };
            log.warn("secondary native harness compaction threw after context-engine compaction", {
              errorMessage: formatErrorMessage(err),
            });
          }
        }
        const secondaryNativeDetailsKey =
          normalizeOptionalAgentRuntimeId(preparedHarnessRuntime) === "codex"
            ? "codexNativeCompaction"
            : "nativeHarnessCompaction";
        return {
          ok: result.ok,
          compacted: result.compacted,
          reason: result.reason,
          result: result.result
            ? {
                summary: result.result.summary ?? "",
                firstKeptEntryId: result.result.firstKeptEntryId ?? "",
                tokensBefore: result.result.tokensBefore,
                tokensAfter: result.result.tokensAfter,
                details: mergeSecondaryNativeHarnessCompactionDetails({
                  details: result.result.details,
                  nativeResult: secondaryNativeHarnessCompaction,
                  detailsKey: secondaryNativeDetailsKey,
                }),
                ...(postCompactionSessionId !== params.sessionId
                  ? { sessionId: postCompactionSessionId }
                  : {}),
                ...(postCompactionSessionFile !== params.sessionFile
                  ? { sessionFile: postCompactionSessionFile }
                  : {}),
              }
            : undefined,
        };
      } finally {
        if (!checkpointSnapshotRetained) {
          await compactionCheckpointStore.cleanupSnapshot(checkpointSnapshot);
        }
      }
    }),
  );
}

function shouldAttemptNativeHarnessCompaction(params: {
  provider: string;
  nativeHarnessCompaction?: boolean;
  selectedHarnessRuntime?: string | null;
}): boolean {
  const selectedRuntime = normalizeOptionalAgentRuntimeId(params.selectedHarnessRuntime);
  if (!selectedRuntime || selectedRuntime === "auto" || selectedRuntime === "openclaw") {
    return false;
  }
  return isOpenAIProvider(params.provider) ? params.nativeHarnessCompaction === true : true;
}

function buildCompactionContextEngineRuntimeContext(params: {
  params: CompactEmbeddedAgentSessionParams;
  agentDir: string;
  harnessRuntime?: string;
  contextEnginePluginId?: string;
  contextTokenBudget?: number;
}): ContextEngineRuntimeContext {
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.params.sessionKey,
    config: params.params.config,
    agentId: params.params.agentId,
  });
  const { sessionFile: _sessionFile, ...runtimeParams } = params.params;
  return {
    ...runtimeParams,
    sessionTarget: buildContextEngineCompactionSessionTarget(params.params),
    ...buildEmbeddedCompactionRuntimeContext({
      sessionKey: params.params.sessionKey,
      messageChannel: params.params.messageChannel,
      messageProvider: params.params.messageProvider,
      agentAccountId: params.params.agentAccountId,
      currentChannelId: params.params.currentChannelId,
      currentThreadTs: params.params.currentThreadTs,
      currentMessageId: params.params.currentMessageId,
      authProfileId: params.params.authProfileId,
      authProfileIdSource: params.params.authProfileIdSource,
      runtimeAuthPlan: params.params.runtimeAuthPlan,
      workspaceDir: params.params.workspaceDir,
      cwd: params.params.cwd,
      agentDir: params.agentDir,
      config: params.params.config,
      skillsSnapshot: params.params.skillsSnapshot,
      senderIsOwner: params.params.senderIsOwner,
      senderId: params.params.senderId,
      provider: params.params.provider,
      modelId: params.params.model,
      harnessRuntime: params.harnessRuntime,
      modelSelectionLocked: params.params.modelSelectionLocked,
      modelFallbacksOverride: params.params.modelFallbacksOverride,
      thinkLevel: params.params.thinkLevel,
      reasoningLevel: params.params.reasoningLevel,
      bashElevated: params.params.bashElevated,
      extraSystemPrompt: params.params.extraSystemPrompt,
      sourceReplyDeliveryMode: params.params.sourceReplyDeliveryMode,
      ownerNumbers: params.params.ownerNumbers,
    }),
    ...resolveContextEngineCapabilities({
      config: params.params.config,
      sessionKey: params.params.sessionKey,
      agentId: sessionAgentId,
      authProfileId: params.params.authProfileId,
      contextEnginePluginId: params.contextEnginePluginId,
      purpose: "context-engine.compaction",
    }),
    tokenBudget: params.contextTokenBudget,
    currentTokenCount: params.params.currentTokenCount,
  };
}
