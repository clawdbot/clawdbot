/**
 * Public facade and fallback coordinator for embedded-agent compaction.
 */
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveUserPath } from "../../utils.js";
import { normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveRunModelFallbacksOverride,
  resolveSessionAgentIds,
} from "../agent-scope.js";
import { hasMeaningfulConversationContent } from "../compaction-real-conversation.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { coerceToFailoverError } from "../failover-error.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { isFallbackSummaryError } from "../model-fallback-attempt.js";
import { resolveModelCandidateChain } from "../model-fallback-candidates.js";
import { runWithModelFallback } from "../model-fallback-runner.js";
import { acquireAgentRunPreparedModelRuntime } from "../prepared-model-runtime.js";
import {
  applyAgentRunSessionTargetIdentity,
  resolveAgentRunSessionTarget,
} from "../run-session-target.js";
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
import { prepareCompactionSessionAgent } from "./compaction-session-agent.js";
import type { PreparedCompactEmbeddedAgentSessionParams } from "./direct-compaction-preparation.js";
import { compactEmbeddedAgentSessionDirectOnce } from "./direct-compaction.js";
import { hardenManualCompactionBoundary } from "./manual-compaction-boundary.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

export type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";

type CompactEmbeddedAgentSessionParamsWithSessionFile = CompactEmbeddedAgentSessionRuntimeParams & {
  sessionFile: string;
};

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
  const lockedHarnessRuntime = normalizeOptionalAgentRuntimeId(paramsBase.agentHarnessId);
  if (paramsBase.modelSelectionLocked === true && lockedHarnessRuntime !== "openclaw") {
    return {
      ok: false,
      compacted: false,
      reason: lockedHarnessRuntime
        ? `Model selection is locked to native agent harness "${lockedHarnessRuntime}"; generic compaction is unavailable.`
        : "Model selection is locked but the persisted agent harness is unavailable.",
      failure: { reason: "model_selection_locked" },
    };
  }
  const runSessionTarget = await resolveAgentRunSessionTarget(paramsBase);
  const requestedParams: CompactEmbeddedAgentSessionParamsWithSessionFile = {
    ...paramsBase,
    agentId: paramsBase.agentId ?? runSessionTarget.agentId,
    sessionId: runSessionTarget.sessionId,
    sessionKey: paramsBase.sessionKey ?? runSessionTarget.sessionKey,
    sessionFile: runSessionTarget.sessionFile,
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
  const preparedModelRuntimeLease = await acquireAgentRunPreparedModelRuntime({
    config: requestedParams.config ?? {},
    agentId: requestedAgentIds.sessionAgentId,
    agentDir: requestedAgentDir,
    inheritedAuthDir: resolveDefaultAgentDir(requestedParams.config ?? {}),
    workspaceDir: requestedWorkspaceDir,
    preserveWorkspaceDirOnRefresh: requestedWorkspaceDir !== canonicalWorkspaceDir,
  });
  try {
    const preparedModelRuntime = preparedModelRuntimeLease.snapshot;
    // Fallback policy and every attempt consume the same generation as model/auth discovery.
    // A reload may have committed while session targeting was resolved above.
    const params: PreparedCompactEmbeddedAgentSessionParams = {
      ...requestedParams,
      config: preparedModelRuntime.config,
      agentId: preparedModelRuntime.agentId ?? requestedAgentIds.sessionAgentId,
      agentDir: preparedModelRuntime.agentDir,
      workspaceDir: preparedModelRuntime.workspaceDir ?? requestedWorkspaceDir,
      preparedModelRuntime,
    };
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
    const fallbacksOverride = resolveCompactionFallbacksOverride(params);
    const resolvedPrimaryCandidate = resolveModelCandidateChain({
      cfg: params.config,
      provider: primaryProvider,
      model: primaryModel,
      requestedRouteResolution: "resolved",
      fallbacksOverride,
    })[0];
    const fallbackAgentId = resolveSessionAgentIds({
      sessionKey: params.sandboxSessionKey ?? params.sessionKey,
      config: params.config,
      agentId: params.agentId,
    }).sessionAgentId;
    const fallbackSessionKey = params.sandboxSessionKey ?? params.sessionKey ?? params.sessionId;
    const fallbackResult = await runWithModelFallback<EmbeddedAgentCompactResult>({
      cfg: params.config,
      provider: primaryProvider,
      model: primaryModel,
      requestedRouteResolution: "resolved",
      runId: params.runId ?? params.sessionId,
      agentDir: params.agentDir,
      agentId: fallbackAgentId,
      sessionId: params.sessionId,
      sessionKey: fallbackSessionKey,
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
          isPrimaryCandidate ||
          provider === primaryProvider ||
          provider === requestedPrimaryProvider;
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
  } catch (err) {
    return fallbackFailureToCompactionResult(err);
  } finally {
    preparedModelRuntimeLease.release();
  }
}

export const testing = {
  hasRealConversationContent,
  hasMeaningfulConversationContent,
  containsRealConversationMessages,
  estimateTokensAfterCompaction,
  buildBeforeCompactionHookMetrics,
  hardenManualCompactionBoundary,
  resolveCompactionProviderStream,
  prepareCompactionSessionAgent,
  runBeforeCompactionHooks,
  runAfterCompactionHooks,
  runPostCompactionSideEffects,
} as const;
