/**
 * Public facade and fallback coordinator for embedded-agent compaction.
 */
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import { resolveUserPath } from "../../utils.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveRunModelFallbacksOverride,
  resolveSessionAgentIds,
} from "../agent-scope.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import { hasMeaningfulConversationContent } from "../compaction-real-conversation.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { coerceToFailoverError } from "../failover-error.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { isFallbackSummaryError } from "../model-fallback-attempt.js";
import { resolveModelCandidateChain } from "../model-fallback-candidates.js";
import { runWithModelFallback } from "../model-fallback-runner.js";
import { acquireAgentRunPreparedModelRuntime } from "../prepared-model-runtime.js";
import { resolveProjectKey } from "../project-memory-scope.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import {
  applyAgentRunSessionTargetIdentity,
  resolveAgentRunSessionTarget,
} from "../run-session-target.js";
import { resolveSystemPromptRepoRoot } from "../system-prompt-params.js";
import type {
  CompactEmbeddedAgentSessionParams,
  CompactEmbeddedAgentSessionRuntimeParams,
} from "./compact.types.js";
import {
  containsRealConversationMessages,
  hasRealConversationContent,
  resolveCompactionProviderStream,
} from "./compaction-diagnostics.js";
import {
  buildBeforeCompactionHookMetrics,
  estimateTokensAfterCompaction,
  runAfterCompactionHooks,
  runBeforeCompactionHooks,
  runPostCompactionSideEffects,
} from "./compaction-hooks.js";
import { resolveEmbeddedCompactionTarget } from "./compaction-runtime-context.js";
import { resolveCompactionRuntimeSelection } from "./compaction-runtime-preparation.js";
import { resolveCompactionTimeoutMs } from "./compaction-safety-timeout.js";
import { prepareCompactionSessionAgent } from "./compaction-session-agent.js";
import type { PreparedCompactEmbeddedAgentSessionParams } from "./direct-compaction-preparation.js";
import { compactEmbeddedAgentSessionDirectOnce } from "./direct-compaction.js";
import { readCompactionAccountingRecorder } from "./run/compaction-accounting-bridge.js";
import { prepareEmbeddedSessionActiveProjectKeys } from "./session-prompt-state.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

export type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";

type CompactEmbeddedAgentSessionParamsWithSessionFile = CompactEmbeddedAgentSessionRuntimeParams & {
  sessionFile: string;
};

function lockedHarnessCompactionFailure(runtime: string): EmbeddedAgentCompactResult {
  return {
    ok: false,
    compacted: false,
    reason: `Model selection is locked to native agent harness "${runtime}"; generic compaction is unavailable.`,
    failure: { reason: "model_selection_locked" },
  };
}

export async function compactNativeCliSession(params: {
  runtime: string | undefined;
  compactParams: CompactEmbeddedAgentSessionParamsWithSessionFile;
  runControlOperation?: (run: () => Promise<void>) => Promise<void>;
}): Promise<EmbeddedAgentCompactResult | undefined> {
  const runtime = normalizeOptionalAgentRuntimeId(params.runtime);
  if (!runtime || params.compactParams.trigger !== "manual") {
    return undefined;
  }
  const backend = resolveCliBackendConfig(runtime, params.compactParams.config, {
    agentId: params.compactParams.agentId,
  });
  if (!backend?.ownsNativeCompaction) {
    return undefined;
  }
  const manualCompaction = backend.manualCompaction;
  if (!manualCompaction) {
    return {
      ok: false,
      compacted: false,
      reason: `CLI backend "${runtime}" owns compaction but does not support manual compaction.`,
    };
  }
  const cliSessionBinding = params.compactParams.cliSessionBinding;
  const cliSessionId = (cliSessionBinding?.sessionId ?? params.compactParams.cliSessionId)?.trim();
  if (!cliSessionId) {
    return {
      ok: false,
      compacted: false,
      reason: `CLI backend "${runtime}" cannot manually compact without a resumable native session.`,
    };
  }
  const { runCliAgent } = await import("../cli-runner.js");
  const runId = `${params.compactParams.runId ?? params.compactParams.sessionId}:native-compact`;
  const sessionAgentId = resolveSessionAgentIds({
    sessionKey: params.compactParams.sessionKey,
    config: params.compactParams.config,
    agentId: params.compactParams.agentId,
  }).sessionAgentId;
  const preparedRunAdmission = prepareSystemAgentRunAdmission(
    params.compactParams.config ?? {},
    runId,
    sessionAgentId,
    "agents.native-compaction",
  );
  try {
    const runControlOperation = async () => {
      await runCliAgent({
        preparedRunAdmission,
        sessionId: params.compactParams.sessionId,
        sessionKey: params.compactParams.sessionKey,
        sessionFile: params.compactParams.sessionFile,
        agentId: params.compactParams.agentId,
        workspaceDir: params.compactParams.workspaceDir,
        cwd: params.compactParams.cwd,
        agentDir: params.compactParams.agentDir,
        config: params.compactParams.config,
        prompt: manualCompaction.buildPrompt(params.compactParams.customInstructions),
        provider: runtime,
        modelProvider: params.compactParams.provider,
        model: params.compactParams.model,
        thinkLevel: params.compactParams.thinkLevel,
        timeoutMs: resolveCompactionTimeoutMs(params.compactParams.config),
        runId,
        cliSessionId,
        ...(cliSessionBinding ? { cliSessionBinding } : {}),
        ...(cliSessionBinding?.authProfileId
          ? { authProfileId: cliSessionBinding.authProfileId }
          : params.compactParams.authProfileId
            ? { authProfileId: params.compactParams.authProfileId }
            : {}),
        ...(params.compactParams.sessionEntry
          ? { sessionEntry: params.compactParams.sessionEntry }
          : {}),
        contextWindow: params.compactParams.sessionEntry?.contextWindow,
        trigger: "manual",
        controlOperation: "compact",
        disableCliLiveSession: true,
        // Compaction rewrites the persisted session behind any idle SDK query. Retire that query
        // after the control turn so the next user turn reloads the compacted conversation.
        cleanupCliLiveSessionOnRunEnd: true,
        allowEmptyAssistantReplyAsSilent: true,
        abortSignal: params.compactParams.abortSignal,
      });
    };
    if (params.runControlOperation) {
      await params.runControlOperation(runControlOperation);
    } else {
      await runControlOperation();
    }
  } catch (err) {
    return {
      ok: false,
      compacted: false,
      reason: `CLI backend "${runtime}" failed to compact its native session: ${formatErrorMessage(err)}`,
    };
  } finally {
    preparedRunAdmission.close();
  }
  return {
    ok: true,
    compacted: true,
    reason: `CLI backend "${runtime}" compacted its native session.`,
  };
}

function hasExplicitCompactionModel(params: CompactEmbeddedAgentSessionParams): boolean {
  return Boolean(params.config?.agents?.defaults?.compaction?.model?.trim());
}

function resolveCompactionFallbacksOverride(
  params: CompactEmbeddedAgentSessionParams,
): string[] | undefined {
  if (params.modelSelectionLocked) {
    return [];
  }
  return (
    params.modelFallbacksOverride ??
    resolveRunModelFallbacksOverride({
      cfg: params.config,
      sessionKey: params.sessionKey,
    })
  );
}

function hasCompactionModelFallbackCandidates(params: CompactEmbeddedAgentSessionParams): boolean {
  const fallbacksOverride = resolveCompactionFallbacksOverride(params);
  const defaultFallbacks = resolveAgentModelFallbackValues(params.config?.agents?.defaults?.model);
  return (fallbacksOverride ?? defaultFallbacks).length > 0;
}

function classifyCompactionFallbackResult(
  result: EmbeddedAgentCompactResult,
  provider: string,
  model: string,
) {
  if (result.ok) {
    return null;
  }
  const reason = result.reason?.trim();
  if (!reason) {
    return null;
  }
  const failureError = Object.assign(new Error(result.failure?.rawError ?? reason), {
    status: result.failure?.status,
    code: result.failure?.code,
  });
  const failoverError = coerceToFailoverError(failureError, { provider, model });
  return failoverError ? { error: failoverError } : null;
}

function fallbackFailureToCompactionResult(err: unknown): EmbeddedAgentCompactResult {
  const reason = isFallbackSummaryError(err) ? err.message : formatErrorMessage(err);
  return {
    ok: false,
    compacted: false,
    reason,
  };
}

/**
 * Core compaction logic without lane queueing.
 * Use this when already inside a session/global lane to avoid deadlocks.
 */
export async function compactEmbeddedAgentSessionDirect(
  paramsInput: CompactEmbeddedAgentSessionRuntimeParams,
): Promise<EmbeddedAgentCompactResult> {
  const paramsBase = applyAgentRunSessionTargetIdentity(paramsInput);
  const memoryTranscript = readCompactionAccountingRecorder(
    paramsBase.contextEngineRuntimeContext,
  )?.memoryTranscript;
  memoryTranscript?.assertActive();
  const runSessionTarget =
    memoryTranscript?.sessionTarget ??
    (await resolveAgentRunSessionTarget({
      ...paramsBase,
      missingSessionKey: "resolve-existing",
    }));
  const entry = loadSessionEntryReadOnly({ ...runSessionTarget, readConsistency: "latest" });
  const lockedHarnessRuntime = resolveSessionPinnedHarnessId(entry);
  const requestedParams: CompactEmbeddedAgentSessionParamsWithSessionFile = {
    ...paramsBase,
    sessionEntry: entry ? projectPublicSessionEntry(entry) : undefined,
    agentHarnessId: lockedHarnessRuntime ?? paramsBase.agentHarnessId,
    modelSelectionLocked: entry?.modelSelectionLocked ?? paramsBase.modelSelectionLocked,
    agentId: runSessionTarget.agentId,
    sessionId: runSessionTarget.sessionId,
    sessionKey: runSessionTarget.sessionKey,
    // SQLite resolves storage identity; the request still owns thread routing.
    sessionTarget: {
      agentId: runSessionTarget.agentId,
      sessionId: runSessionTarget.sessionId,
      sessionKey: runSessionTarget.sessionKey,
      storePath: runSessionTarget.storePath,
      ...(paramsBase.sessionTarget?.threadId !== undefined
        ? { threadId: paramsBase.sessionTarget.threadId }
        : {}),
    },
    sessionFile: runSessionTarget.sessionKey,
  };
  const requestedAgentIds = resolveSessionAgentIds({
    sessionKey: requestedParams.sessionKey,
    config: requestedParams.config,
    agentId: requestedParams.agentId,
  });
  const requestedAgentDir =
    requestedParams.agentDir ??
    resolveAgentDir(requestedParams.config ?? {}, requestedAgentIds.sessionAgentId);
  const requestedWorkspaceDir = resolveUserPath(requestedParams.workspaceDir);
  const canonicalWorkspaceDir = resolveUserPath(
    resolveAgentWorkspaceDir(requestedParams.config ?? {}, requestedAgentIds.sessionAgentId),
  );
  const runtimeSelection = resolveCompactionRuntimeSelection({
    ...requestedParams,
    modelId: requestedParams.model,
    boundHarnessRuntime: requestedParams.agentHarnessId,
    preparedRuntimePlan: requestedParams.runtimePlan,
  });
  // Native control operations reuse the backend's existing authenticated session.
  // Run them before generic model preparation so subscription-only CLI sessions do
  // not incorrectly require an OpenClaw model API credential.
  const nativeCliResult = await compactNativeCliSession({
    runtime: runtimeSelection.selectedHarnessRuntime,
    compactParams: {
      ...requestedParams,
      agentDir: requestedAgentDir,
      workspaceDir: requestedWorkspaceDir,
    },
  });
  if (nativeCliResult) {
    return nativeCliResult;
  }
  if (lockedHarnessRuntime && lockedHarnessRuntime !== "openclaw") {
    return lockedHarnessCompactionFailure(lockedHarnessRuntime);
  }
  const pluginPlanCompactionTarget = resolveEmbeddedCompactionTarget({
    config: requestedParams.config,
    provider: requestedParams.provider,
    modelId: requestedParams.model,
    authProfileId: requestedParams.authProfileId,
    modelSelectionLocked: requestedParams.modelSelectionLocked,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const currentPluginMetadataSnapshot = getCurrentPluginMetadataSnapshot({
    config: requestedParams.config ?? {},
    workspaceDir: requestedWorkspaceDir,
    env: process.env,
    allowWorkspaceScopedSnapshot: true,
  });
  const pluginPlanCandidates = resolveModelCandidateChain({
    cfg: requestedParams.config,
    agentId: requestedAgentIds.sessionAgentId,
    manifestPlugins: currentPluginMetadataSnapshot ?? [],
    provider: pluginPlanCompactionTarget.provider ?? DEFAULT_PROVIDER,
    model: pluginPlanCompactionTarget.model ?? DEFAULT_MODEL,
    requestedRouteResolution: "resolved",
    fallbacksOverride: resolveCompactionFallbacksOverride(requestedParams),
  });
  const runtimePluginSelections = [
    {
      provider: runtimeSelection.provider,
      modelId: runtimeSelection.modelId,
      ...(runtimeSelection.selectedHarnessRuntime
        ? { runtime: runtimeSelection.selectedHarnessRuntime }
        : {}),
      agentId: requestedAgentIds.sessionAgentId,
    },
    ...pluginPlanCandidates
      .filter(
        (candidate) =>
          candidate.provider !== runtimeSelection.provider ||
          candidate.model !== runtimeSelection.modelId,
      )
      .map((candidate) =>
        runtimeSelection.boundHarnessRuntime
          ? {
              provider: candidate.provider,
              modelId: candidate.model,
              runtime: runtimeSelection.boundHarnessRuntime,
              agentId: requestedAgentIds.sessionAgentId,
            }
          : {
              provider: candidate.provider,
              modelId: candidate.model,
              agentId: requestedAgentIds.sessionAgentId,
            },
      ),
  ];
  const preparedModelRuntimeLease = await acquireAgentRunPreparedModelRuntime({
    config: requestedParams.config ?? {},
    agentId: requestedAgentIds.sessionAgentId,
    agentDir: requestedAgentDir,
    workspaceDir: requestedWorkspaceDir,
    preserveWorkspaceDirOnRefresh: requestedWorkspaceDir !== canonicalWorkspaceDir,
    ...(requestedParams.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
    runtimePluginSelections,
  });
  try {
    const preparedModelRuntimeOwnerSnapshot = preparedModelRuntimeLease.snapshot;
    const preparedWorkspaceDir =
      preparedModelRuntimeOwnerSnapshot.workspaceDir ?? requestedWorkspaceDir;
    const repoRoot =
      resolveSystemPromptRepoRoot({
        config: preparedModelRuntimeOwnerSnapshot.config,
        workspaceDir: preparedWorkspaceDir,
        cwd: requestedParams.cwd,
      }) ?? null;
    const projectKey = repoRoot ? await resolveProjectKey(repoRoot) : null;
    const activeProjectKeys = prepareEmbeddedSessionActiveProjectKeys(
      requestedParams.sessionId,
      projectKey,
    );
    const preparedModelRuntime = Object.freeze({
      ...preparedModelRuntimeOwnerSnapshot,
      repoRoot,
      projectKey,
      activeProjectKeys,
    });
    // Fallback policy and every attempt consume the same generation as model/auth discovery.
    // A reload may have committed while session targeting was resolved above.
    const params: PreparedCompactEmbeddedAgentSessionParams = {
      ...requestedParams,
      config: preparedModelRuntime.config,
      agentId: preparedModelRuntime.agentId ?? requestedAgentIds.sessionAgentId,
      agentDir: preparedModelRuntime.agentDir,
      workspaceDir: preparedWorkspaceDir,
      preparedModelRuntime,
    };
    const compactPrepared = async () => {
      if (hasExplicitCompactionModel(params) || !hasCompactionModelFallbackCandidates(params)) {
        return await compactEmbeddedAgentSessionDirectOnce(params);
      }
      const resolvedCompactionTarget = resolveEmbeddedCompactionTarget({
        config: params.config,
        provider: params.provider,
        modelId: params.model,
        authProfileId: params.authProfileId,
        modelSelectionLocked: params.modelSelectionLocked,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const primaryProvider = resolvedCompactionTarget.provider ?? DEFAULT_PROVIDER;
      const primaryModel = resolvedCompactionTarget.model ?? DEFAULT_MODEL;
      const requestedPrimaryProvider = params.provider?.trim() || DEFAULT_PROVIDER;
      const resolveAuthProvider = (provider: string) =>
        resolveProviderIdForAuth(provider, {
          config: params.config,
          metadataSnapshot: preparedModelRuntime.metadataSnapshot,
        });
      const primaryAuthProviders = new Set(
        [primaryProvider, requestedPrimaryProvider].map(resolveAuthProvider),
      );
      const fallbacksOverride = resolveCompactionFallbacksOverride(params);
      const fallbackAgentId = resolveSessionAgentIds({
        sessionKey: params.sandboxSessionKey ?? params.sessionKey,
        config: params.config,
        agentId: params.sandboxAgentId ?? params.agentId,
      }).sessionAgentId;
      const resolvedPrimaryCandidate = resolveModelCandidateChain({
        cfg: params.config,
        agentId: fallbackAgentId,
        manifestPlugins: preparedModelRuntime.metadataSnapshot,
        provider: primaryProvider,
        model: primaryModel,
        requestedRouteResolution: "resolved",
        fallbacksOverride,
      })[0];
      const fallbackSessionKey = params.sandboxSessionKey ?? params.sessionKey ?? params.sessionId;
      const fallbackResult = await runWithModelFallback<EmbeddedAgentCompactResult>({
        cfg: params.config,
        manifestPlugins: preparedModelRuntime.metadataSnapshot,
        provider: primaryProvider,
        model: primaryModel,
        requestedRouteResolution: "resolved",
        runId: params.runId ?? params.sessionId,
        agentDir: params.agentDir,
        agentId: fallbackAgentId,
        sessionId: params.sessionId,
        sessionKey: fallbackSessionKey,
        userLockedAuthProfileId:
          params.authProfileIdSource === "user" ? params.authProfileId : undefined,
        abortSignal: params.abortSignal,
        prepareAgentHarnessRuntime: async ({ provider, model, agentHarnessRuntimeOverride }) => {
          await ensureSelectedAgentHarnessPlugin({
            config: params.config,
            provider,
            modelId: model,
            agentId: fallbackAgentId,
            sessionKey: fallbackSessionKey,
            agentHarnessRuntimeOverride,
            workspaceDir: params.workspaceDir,
            pluginRegistry: preparedModelRuntime.pluginRegistry!,
          });
        },
        fallbacksOverride,
        classifyResult: ({ result, provider, model }) =>
          classifyCompactionFallbackResult(result, provider, model),
        run: async (provider, model) => {
          const isPrimaryCandidate =
            provider === resolvedPrimaryCandidate?.provider &&
            model === resolvedPrimaryCandidate.model;
          const preservesPrimaryAuth =
            isPrimaryCandidate || primaryAuthProviders.has(resolveAuthProvider(provider));
          const authProfileId = preservesPrimaryAuth ? params.authProfileId : undefined;
          return await compactEmbeddedAgentSessionDirectOnce({
            ...params,
            provider,
            model,
            authProfileId,
            authProfileIdSource: preservesPrimaryAuth ? params.authProfileIdSource : undefined,
            // The primary attempt retains its already prepared atomic plan. An
            // actual fallback may change route/auth class and must rebuild it.
            runtimeAuthPlan: isPrimaryCandidate ? params.runtimeAuthPlan : undefined,
            runtimePlan: isPrimaryCandidate ? params.runtimePlan : undefined,
          });
        },
      });
      return fallbackResult.result;
    };
    return await withPluginRuntimeGenerationScope(preparedModelRuntime, compactPrepared);
  } catch (err) {
    return fallbackFailureToCompactionResult(err);
  } finally {
    preparedModelRuntimeLease.release();
  }
}

export const testing = {
  compactNativeCliSession,
  hasRealConversationContent,
  hasMeaningfulConversationContent,
  containsRealConversationMessages,
  estimateTokensAfterCompaction,
  buildBeforeCompactionHookMetrics,
  resolveCompactionProviderStream,
  prepareCompactionSessionAgent,
  runBeforeCompactionHooks,
  runAfterCompactionHooks,
  runPostCompactionSideEffects,
} as const;
