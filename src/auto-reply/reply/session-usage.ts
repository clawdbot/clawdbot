/** Persists usage, cost, and model metadata after reply runs. */
import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { clearCliSession } from "../../agents/cli-session.js";
import {
  deriveSessionTotalTokens,
  hasBillableUsage,
  hasNonzeroUsage,
  type NormalizedUsage,
} from "../../agents/usage.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  resolveSessionGoalDisplayState,
  SESSION_TOTAL_TOKENS_VERSION,
  type SessionSystemPromptReport,
  type SessionEntry,
} from "../../config/sessions.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { estimateAggregateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";

function applyCliSessionClearToSessionPatch(
  params: {
    providerUsed?: string;
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
  return patch;
}

function resolveNonNegativeTokenCount(value: number | undefined): number | undefined {
  const resolved = asNonNegativeFiniteNumber(value);
  return resolved === undefined ? undefined : Math.floor(resolved);
}

function estimateSessionRunCostUsd(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  usage?: NormalizedUsage;
  providerUsed?: string;
  modelUsed?: string;
}): number | undefined {
  if (!hasBillableUsage(params.usage)) {
    return undefined;
  }
  const cost = resolveModelCostConfig({
    provider: params.providerUsed,
    model: params.modelUsed,
    config: params.cfg,
    agentDir: params.agentDir,
  });
  return asNonNegativeFiniteNumber(estimateAggregateUsageCost({ usage: params.usage, cost }));
}

/** Persists usage accounting and selected runtime metadata to the session store. */
export async function persistSessionUsageUpdate(params: {
  agentId?: string;
  storePath?: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  expectedSession?: Pick<
    InternalSessionEntry,
    "sessionId" | "lifecycleRevision" | "activeWriterRunId"
  >;
  authorize?: () => boolean;
  cfg?: OpenClawConfig;
  agentDir?: string;
  usage?: NormalizedUsage;
  /**
   * Usage from the last individual API call (not accumulated). Supplies context
   * only when no chronology-qualified currentContextSnapshot was observed.
   */
  lastCallUsage?: NormalizedUsage;
  modelUsed?: string;
  providerUsed?: string;
  agentHarnessId?: string;
  contextTokensUsed?: number;
  contextTokensSource?: SessionEntry["contextTokensSource"];
  contextBudgetStatus?: SessionEntry["contextBudgetStatus"];
  promptTokens?: number;
  isHeartbeat?: boolean;
  systemPromptReport?: SessionSystemPromptReport;
  /** Compaction invalidates native continuity with its accounting commit. */
  clearCliSessionBinding?: boolean;
  /** Presence overrides usage inference; undefined tokens explicitly mean current context is unknown. */
  currentContextSnapshot?: { tokens: number | undefined };
  preserveFreshTotalTokensOnStaleUsage?: boolean;
  preserveRuntimeModel?: boolean;
  preserveUserFacingSessionModelState?: boolean;
  logLabel?: string;
}): Promise<void> {
  const { agentId, storePath, sessionKey, sessionStore, authorize } = params;
  if (!storePath || !sessionKey) {
    return;
  }
  const expectedSession = params.expectedSession ? { ...params.expectedSession } : undefined;

  const label = params.logLabel ? `${params.logLabel} ` : "";
  const cfg = params.cfg ?? getRuntimeConfig();
  const agentHarnessId = normalizeOptionalString(params.agentHarnessId);
  const hasUsage = hasNonzeroUsage(params.usage);
  const hasBilling = hasBillableUsage(params.usage);
  const hasPromptTokens =
    typeof params.promptTokens === "number" &&
    Number.isFinite(params.promptTokens) &&
    params.promptTokens > 0;
  const hasUsableLastCallUsage =
    Boolean(params.lastCallUsage) && params.lastCallUsage?.contextUsage?.state !== "unavailable";
  const hasFreshContextSnapshot = hasUsableLastCallUsage || hasPromptTokens;
  const hasCurrentContextSnapshot = params.currentContextSnapshot !== undefined;
  const currentContextTokens = resolveNonNegativeTokenCount(params.currentContextSnapshot?.tokens);

  // A monetary-only update must not invalidate the existing context observation.
  const hasContextUpdate =
    hasUsage ||
    hasFreshContextSnapshot ||
    hasCurrentContextSnapshot ||
    Boolean(params.modelUsed || params.contextTokensUsed);
  if (hasBilling || hasContextUpdate) {
    try {
      await patchSessionEntryCore(
        { agentId, storePath, sessionKey },
        (entry) => {
          // Retained compaction facts carry an exact writer, including known absence;
          // ordinary usage callers may carry only the existing generation fence.
          if (
            !(authorize?.() ?? true) ||
            (expectedSession &&
              (entry.sessionId !== expectedSession.sessionId ||
                entry.lifecycleRevision !== expectedSession.lifecycleRevision ||
                (Object.hasOwn(expectedSession, "activeWriterRunId") &&
                  entry.activeWriterRunId !== expectedSession.activeWriterRunId)))
          ) {
            return null;
          }
          const updatedAt = Date.now();
          const preserveSessionModelState =
            params.isHeartbeat === true ||
            params.preserveRuntimeModel === true ||
            params.preserveUserFacingSessionModelState === true;
          const preserveUserFacingRunState = params.preserveUserFacingSessionModelState === true;
          const resolvedContextTokens = preserveSessionModelState
            ? entry.contextTokens
            : (params.contextTokensUsed ?? entry.contextTokens);
          // Arrival order owns context freshness; an older model result cannot replace
          // a later compaction or an explicit unknown observation. Billing stays separate.
          const totalTokens = hasCurrentContextSnapshot
            ? currentContextTokens
            : hasFreshContextSnapshot
              ? deriveSessionTotalTokens({
                  lastCallUsage: params.lastCallUsage,
                  contextTokens: resolvedContextTokens,
                  promptTokens: params.promptTokens,
                })
              : undefined;
          const runEstimatedCostUsd = preserveUserFacingRunState
            ? undefined
            : estimateSessionRunCostUsd({
                cfg,
                agentDir: params.agentDir,
                usage: params.usage,
                providerUsed: params.providerUsed ?? entry.modelProvider,
                modelUsed: params.modelUsed ?? entry.model,
              });
          const patch: Partial<SessionEntry> = {
            modelProvider: preserveSessionModelState
              ? entry.modelProvider
              : (params.providerUsed ?? entry.modelProvider),
            model: preserveSessionModelState ? entry.model : (params.modelUsed ?? entry.model),
            ...(!preserveSessionModelState
              ? {
                  agentHarnessId,
                  contextTokensSource: params.contextTokensSource,
                  contextBudgetStatus: params.contextBudgetStatus,
                }
              : {}),
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
            // Cache buckets retain the latest call's usage, independently of current context.
            const cacheUsage = params.lastCallUsage ?? params.usage;
            patch.cacheRead = cacheUsage?.cacheRead ?? 0;
            patch.cacheWrite = cacheUsage?.cacheWrite ?? 0;
          }
          if (hasBilling && !preserveUserFacingRunState) {
            // Snapshot cumulative run cost once, including unknown cost; accumulating
            // or retaining a prior amount would attach stale dollars to new tokens.
            patch.estimatedCostUsd = runEstimatedCostUsd;
          }
          if (totalTokens !== undefined && !preserveUserFacingRunState) {
            patch.totalTokens = totalTokens;
            patch.totalTokensFresh = true;
            patch.totalTokensVersion = SESSION_TOTAL_TOKENS_VERSION;
            const accountedGoal = resolveSessionGoalDisplayState({ ...entry, ...patch }, updatedAt);
            if (accountedGoal) {
              patch.goal = accountedGoal;
            }
          } else if (
            !preserveUserFacingRunState &&
            hasContextUpdate &&
            (hasCurrentContextSnapshot ||
              params.preserveFreshTotalTokensOnStaleUsage !== true ||
              entry.totalTokensFresh !== true)
          ) {
            patch.totalTokensFresh = false;
            patch.totalTokensVersion = undefined;
          }
          return preserveUserFacingRunState
            ? patch
            : applyCliSessionClearToSessionPatch(params, entry, patch);
        },
        {
          skipMaintenance: true,
          ...(sessionStore
            ? {
                onCommitted: (entry: InternalSessionEntry) => {
                  // Publish this commit before a newer writer can replace the caller's cache.
                  sessionStore[sessionKey] = entry;
                },
              }
            : {}),
          ...(authorize
            ? {
                assertCommitAllowed: () => {
                  if (!authorize()) {
                    throw new Error("session usage accounting authority revoked");
                  }
                },
              }
            : {}),
        },
      );
    } catch (err) {
      logVerbose(`failed to persist ${label}usage update: ${String(err)}`);
    }
  }
}
