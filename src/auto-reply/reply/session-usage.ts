/** Persists usage, cost, model, and CLI session metadata after reply runs. */
import {
  clearCliSession,
  setCliSessionBinding,
  setCliSessionId,
} from "../../agents/cli-session.js";
import {
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  type NormalizedUsage,
} from "../../agents/usage.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  resolveSessionGoalDisplayState,
  type SessionSystemPromptReport,
  type SessionEntry,
} from "../../config/sessions.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { resolveNonNegativeNumber } from "../../shared/number-coercion.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";

function applyCliSessionIdToSessionPatch(
  params: {
    providerUsed?: string;
    cliSessionId?: string;
    cliSessionBinding?: import("../../config/sessions.js").CliSessionBinding;
    clearCliSessionBinding?: boolean;
  },
  entry: SessionEntry,
  patch: Partial<SessionEntry>,
): Partial<SessionEntry> {
  const cliProvider = params.providerUsed ?? entry.modelProvider;
  if (!cliProvider) {
    return patch;
  }
  if (params.clearCliSessionBinding === true) {
    const nextEntry = { ...entry, ...patch };
    clearCliSession(nextEntry, cliProvider);
    return {
      ...patch,
      cliSessionIds: nextEntry.cliSessionIds,
      cliSessionBindings: nextEntry.cliSessionBindings,
      claudeCliSessionId: nextEntry.claudeCliSessionId,
    };
  }
  if (params.cliSessionBinding) {
    const nextEntry = { ...entry, ...patch };
    setCliSessionBinding(nextEntry, cliProvider, params.cliSessionBinding);
    return {
      ...patch,
      cliSessionIds: nextEntry.cliSessionIds,
      cliSessionBindings: nextEntry.cliSessionBindings,
      claudeCliSessionId: nextEntry.claudeCliSessionId,
    };
  }
  if (params.cliSessionId) {
    const nextEntry = { ...entry, ...patch };
    setCliSessionId(nextEntry, cliProvider, params.cliSessionId);
    return {
      ...patch,
      cliSessionIds: nextEntry.cliSessionIds,
      cliSessionBindings: nextEntry.cliSessionBindings,
      claudeCliSessionId: nextEntry.claudeCliSessionId,
    };
  }
  return patch;
}

function resolveNonNegativeTokenCount(value: number | undefined): number | undefined {
  const resolved = resolveNonNegativeNumber(value);
  return resolved === undefined ? undefined : Math.floor(resolved);
}

function estimateSessionRunCostUsd(params: {
  cfg: OpenClawConfig;
  usage?: NormalizedUsage;
  providerUsed?: string;
  modelUsed?: string;
}): number | undefined {
  if (!hasNonzeroUsage(params.usage)) {
    return undefined;
  }
  const cost = resolveModelCostConfig({
    provider: params.providerUsed,
    model: params.modelUsed,
    config: params.cfg,
  });
  return resolveNonNegativeNumber(estimateUsageCost({ usage: params.usage, cost }));
}

/** Persists usage accounting and selected runtime metadata to the session store. */
export async function persistSessionUsageUpdate(params: {
  storePath?: string;
  sessionKey?: string;
  cfg?: OpenClawConfig;
  usage?: NormalizedUsage;
  /**
   * Usage from the last individual API call (not accumulated). When provided,
   * this is used for `totalTokens` instead of the accumulated `usage` so that
   * context-window utilization reflects the actual current context size rather
   * than the sum of input tokens across all API calls in the run.
   */
  lastCallUsage?: NormalizedUsage;
  modelUsed?: string;
  providerUsed?: string;
  contextTokensUsed?: number;
  promptTokens?: number;
  usageIsContextSnapshot?: boolean;
  isHeartbeat?: boolean;
  systemPromptReport?: SessionSystemPromptReport;
  cliSessionId?: string;
  cliSessionBinding?: import("../../config/sessions.js").CliSessionBinding;
  clearCliSessionBinding?: boolean;
  compactionTokensAfter?: number;
  preserveFreshTotalTokensOnStaleUsage?: boolean;
  preserveRuntimeModel?: boolean;
  preserveUserFacingSessionModelState?: boolean;
  logLabel?: string;
}): Promise<void> {
  const { storePath, sessionKey } = params;
  if (!storePath || !sessionKey) {
    return;
  }

  const label = params.logLabel ? `${params.logLabel} ` : "";
  const cfg = params.cfg ?? getRuntimeConfig();
  const hasUsage = hasNonzeroUsage(params.usage);
  const hasPromptTokens =
    typeof params.promptTokens === "number" &&
    Number.isFinite(params.promptTokens) &&
    params.promptTokens > 0;
  const hasUsableLastCallUsage =
    Boolean(params.lastCallUsage) && params.lastCallUsage?.contextUsage?.state !== "unavailable";
  const hasUsableUsageContextSnapshot =
    params.usageIsContextSnapshot === true && params.usage?.contextUsage?.state !== "unavailable";
  const hasFreshContextSnapshot =
    hasUsableLastCallUsage || hasPromptTokens || hasUsableUsageContextSnapshot;
  const compactionTokensAfter = resolveNonNegativeTokenCount(params.compactionTokensAfter);
  const hasCompactionSnapshot = compactionTokensAfter !== undefined;

  if (hasUsage || hasFreshContextSnapshot || hasCompactionSnapshot) {
    try {
      await updateSessionEntry(
        {
          storePath,
          sessionKey,
        },
        async (entry) => {
          const updatedAt = Date.now();
          const preserveSessionModelState =
            params.isHeartbeat === true ||
            params.preserveRuntimeModel === true ||
            params.preserveUserFacingSessionModelState === true;
          const preserveUserFacingRunState = params.preserveUserFacingSessionModelState === true;
          const resolvedContextTokens = preserveSessionModelState
            ? entry.contextTokens
            : (params.contextTokensUsed ?? entry.contextTokens);
          // Use last-call usage for totalTokens when available. The accumulated
          // `usage.input` sums input tokens from every API call in the run
          // (tool-use loops, compaction retries), overstating actual context.
          // `lastCallUsage` reflects only the final API call — the true context.
          const usageForContext =
            params.lastCallUsage ??
            (params.usageIsContextSnapshot === true ? params.usage : undefined);
          const usageTotalTokens =
            hasFreshContextSnapshot && !preserveUserFacingRunState
              ? deriveSessionTotalTokens({
                  usage: usageForContext,
                  contextTokens: resolvedContextTokens,
                  promptTokens: params.promptTokens,
                })
              : undefined;
          const hasPositiveUsageTotal =
            typeof usageTotalTokens === "number" &&
            Number.isFinite(usageTotalTokens) &&
            usageTotalTokens > 0;
          const useCompactionSnapshot =
            !preserveUserFacingRunState &&
            compactionTokensAfter !== undefined &&
            !hasPositiveUsageTotal;
          const totalTokens = useCompactionSnapshot ? compactionTokensAfter : usageTotalTokens;
          const runEstimatedCostUsd = preserveUserFacingRunState
            ? undefined
            : estimateSessionRunCostUsd({
                cfg,
                usage: params.usage,
                providerUsed: params.providerUsed ?? entry.modelProvider,
                modelUsed: params.modelUsed ?? entry.model,
              });
          const patch: Partial<SessionEntry> = {
            modelProvider: preserveSessionModelState
              ? entry.modelProvider
              : (params.providerUsed ?? entry.modelProvider),
            model: preserveSessionModelState ? entry.model : (params.modelUsed ?? entry.model),
            ...(resolvedContextTokens !== undefined
              ? { contextTokens: resolvedContextTokens }
              : {}),
            systemPromptReport: preserveUserFacingRunState
              ? entry.systemPromptReport
              : (params.systemPromptReport ?? entry.systemPromptReport),
            updatedAt,
          };
          if (hasUsage && !preserveUserFacingRunState) {
            patch.inputTokens = params.usage?.input ?? 0;
            patch.outputTokens = params.usage?.output ?? 0;
            // Cache counters should reflect the latest context snapshot when
            // available, not accumulated per-call totals across a whole run.
            const cacheUsage = params.lastCallUsage ?? params.usage;
            patch.cacheRead = cacheUsage?.cacheRead ?? 0;
            patch.cacheWrite = cacheUsage?.cacheWrite ?? 0;
          }
          if (useCompactionSnapshot && !preserveUserFacingRunState) {
            patch.inputTokens = undefined;
            patch.outputTokens = undefined;
            patch.cacheRead = undefined;
            patch.cacheWrite = undefined;
            patch.contextBudgetStatus = undefined;
          }
          // Snapshot cost like tokens (runEstimatedCostUsd is already computed from
          // cumulative run usage, so assign directly instead of accumulating).
          // Fixes #69347: cost was inflated 1x-72x by accumulating on every persist.
          if (runEstimatedCostUsd !== undefined) {
            patch.estimatedCostUsd = runEstimatedCostUsd;
          }
          if ((hasFreshContextSnapshot || hasCompactionSnapshot) && !preserveUserFacingRunState) {
            patch.totalTokens = totalTokens;
            patch.totalTokensFresh = true;
            const accountedGoal = resolveSessionGoalDisplayState({ ...entry, ...patch }, updatedAt);
            if (accountedGoal) {
              patch.goal = accountedGoal;
            }
          } else if (
            !preserveUserFacingRunState &&
            (params.preserveFreshTotalTokensOnStaleUsage !== true ||
              entry.totalTokensFresh !== true)
          ) {
            patch.totalTokensFresh = false;
          }
          return preserveUserFacingRunState
            ? patch
            : applyCliSessionIdToSessionPatch(params, entry, patch);
        },
        {
          skipMaintenance: true,
          takeCacheOwnership: true,
        },
      );
    } catch (err) {
      logVerbose(`failed to persist ${label}usage update: ${String(err)}`);
    }
    return;
  }

  if (params.modelUsed || params.contextTokensUsed) {
    try {
      await updateSessionEntry(
        {
          storePath,
          sessionKey,
        },
        async (entry) => {
          const preserveSessionModelState =
            params.isHeartbeat === true ||
            params.preserveRuntimeModel === true ||
            params.preserveUserFacingSessionModelState === true;
          const preserveUserFacingRunState = params.preserveUserFacingSessionModelState === true;
          const contextTokens = preserveSessionModelState
            ? entry.contextTokens
            : (params.contextTokensUsed ?? entry.contextTokens);
          const patch: Partial<SessionEntry> = {
            modelProvider: preserveSessionModelState
              ? entry.modelProvider
              : (params.providerUsed ?? entry.modelProvider),
            model: preserveSessionModelState ? entry.model : (params.modelUsed ?? entry.model),
            ...(contextTokens !== undefined ? { contextTokens } : {}),
            systemPromptReport: preserveUserFacingRunState
              ? entry.systemPromptReport
              : (params.systemPromptReport ?? entry.systemPromptReport),
            updatedAt: Date.now(),
          };
          if (
            !preserveUserFacingRunState &&
            (params.preserveFreshTotalTokensOnStaleUsage !== true ||
              entry.totalTokensFresh !== true)
          ) {
            // A completed run without a context snapshot invalidates any fresh
            // zero persisted for the previously empty session.
            patch.totalTokensFresh = false;
          }
          return preserveUserFacingRunState
            ? patch
            : applyCliSessionIdToSessionPatch(params, entry, patch);
        },
        {
          skipMaintenance: true,
          takeCacheOwnership: true,
        },
      );
    } catch (err) {
      logVerbose(`failed to persist ${label}model/context update: ${String(err)}`);
    }
  }
}
