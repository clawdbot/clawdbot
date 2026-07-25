/**
 * Updates persisted session metadata after agent command runs.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveCompactionSessionFile,
  setSessionRuntimeModel,
  type SessionEntry,
} from "../../config/sessions.js";
import { patchSessionEntry } from "../../config/sessions/session-accessor.js";
import { projectSessionSnapshotChanges } from "../../config/sessions/session-snapshot-merge.js";
import { resolveMaintenanceConfigFromInput } from "../../config/sessions/store-maintenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveNonNegativeNumber } from "../../shared/number-coercion.js";
import { clearCliSession, setCliSessionBinding, setCliSessionId } from "../cli-session.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { clearMainSessionRecoveryAfterAgentRun } from "../main-session-recovery-clear.js";
import { isCliProvider } from "../model-selection.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../usage.js";

type RunResult = Awaited<ReturnType<(typeof import("../embedded-agent.js"))["runEmbeddedAgent"]>>;

const usageFormatModuleLoader = createLazyImportLoader(() => import("../../utils/usage-format.js"));
const contextModuleLoader = createLazyImportLoader(() => import("../context.js"));

async function getUsageFormatModule() {
  return await usageFormatModuleLoader.load();
}

async function getContextModule() {
  return await contextModuleLoader.load();
}

function resolvePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

/** Applies run result metadata, usage, and CLI bindings to a session entry. */
export async function updateSessionStoreAfterAgentRun(params: {
  cfg: OpenClawConfig;
  contextTokensOverride?: number;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  sessionStore: Record<string, SessionEntry>;
  defaultProvider: string;
  defaultModel: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  result: RunResult;
  touchInteraction?: boolean;
  /**
   * When false, skip the lastActivityAt bump so heartbeat/internal-event runs
   * do not re-flag sessions unread; cron and user-facing runs count as activity.
   */
  touchActivity?: boolean;
  /**
   * When true, preserve the pre-existing runtime model fields (model,
   * modelProvider, contextTokens) on the session entry instead of overwriting
   * them with the model used by this run. Used for heartbeat turns so the
   * heartbeat model does not "bleed" into the main session's perceived state.
   */
  preserveRuntimeModel?: boolean;
  preserveUserFacingSessionModelState?: boolean;
  /** Clear the durable replay-safe recovery guard after this recovery run terminates. */
  clearRestartRecoveryForceSafeTools?: boolean;
}) {
  const {
    cfg,
    sessionId,
    sessionKey,
    storePath,
    sessionStore,
    defaultProvider,
    defaultModel,
    fallbackProvider,
    fallbackModel,
    result,
  } = params;
  const now = Date.now();
  const touchInteraction = params.touchInteraction !== false;
  const touchActivity = params.touchActivity !== false;

  const usage = result.meta.agentMeta?.usage;
  const promptTokens = result.meta.agentMeta?.promptTokens;
  const lastCallUsage = result.meta.agentMeta?.lastCallUsage;
  const compactionTokensAfter =
    typeof result.meta.agentMeta?.compactionTokensAfter === "number" &&
    Number.isFinite(result.meta.agentMeta.compactionTokensAfter) &&
    result.meta.agentMeta.compactionTokensAfter >= 0
      ? Math.floor(result.meta.agentMeta.compactionTokensAfter)
      : undefined;
  const compactionsThisRun = Math.max(0, result.meta.agentMeta?.compactionCount ?? 0);
  const modelUsed = result.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
  const providerUsed = result.meta.agentMeta?.provider ?? fallbackProvider ?? defaultProvider;
  const agentHarnessId = normalizeOptionalString(result.meta.agentMeta?.agentHarnessId);
  const activeSessionFile = normalizeOptionalString(result.meta.agentMeta?.sessionFile);
  const runtimeContextTokens = resolvePositiveInteger(result.meta.agentMeta?.contextTokens);
  const contextBudgetStatus = result.meta.agentMeta?.contextBudgetStatus;
  const contextTokens =
    runtimeContextTokens !== undefined
      ? runtimeContextTokens
      : ((await getContextModule()).resolveContextTokensForModel({
          cfg,
          provider: providerUsed,
          model: modelUsed,
          contextTokensOverride: params.contextTokensOverride,
          fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
          allowAsyncLoad: false,
        }) ?? DEFAULT_CONTEXT_TOKENS);

  const preserveUserFacingRunState = params.preserveUserFacingSessionModelState === true;
  const preserveRuntimeModel = params.preserveRuntimeModel === true || preserveUserFacingRunState;
  const hadPreExistingEntry = sessionStore[sessionKey] !== undefined;
  const entry = sessionStore[sessionKey] ?? {
    sessionId,
    updatedAt: now,
    sessionStartedAt: now,
  };
  const next: SessionEntry = {
    ...entry,
    sessionId,
    updatedAt: now,
    sessionStartedAt: entry.sessionId === sessionId ? (entry.sessionStartedAt ?? now) : now,
    lastInteractionAt: touchInteraction ? now : entry.lastInteractionAt,
    lastActivityAt: touchActivity ? now : entry.lastActivityAt,
    ...(preserveRuntimeModel
      ? {}
      : {
          contextTokens,
        }),
  };
  if (entry.sessionId !== sessionId) {
    next.sessionFile =
      activeSessionFile ??
      resolveCompactionSessionFile({
        entry,
        sessionKey,
        storePath,
        newSessionId: sessionId,
      });
    next.usageFamilyKey = entry.usageFamilyKey ?? sessionKey;
    next.usageFamilySessionIds = Array.from(
      new Set([...(entry.usageFamilySessionIds ?? []), entry.sessionId, sessionId]),
    );
  } else if (activeSessionFile) {
    next.sessionFile = activeSessionFile;
  }
  if (preserveRuntimeModel) {
    // Keep the pre-existing runtime model and context window so a background
    // heartbeat turn using a different model does not bleed into the main
    // session's perceived state.
    if (entry.model) {
      // Prior runtime model exists: preserve its contextTokens. When missing,
      // leave contextTokens unset rather than falling back to the heartbeat
      // run's context window; status derives it from the preserved model.
      next.contextTokens = entry.contextTokens;
      if (entry.modelProvider) {
        setSessionRuntimeModel(next, {
          provider: entry.modelProvider,
          model: entry.model,
        });
      } else {
        // Retain the model-only entry without borrowing the heartbeat provider
        // to avoid invalid cross-provider pairs (e.g. ollama/claude-opus-4-6).
        next.model = entry.model;
      }
    }
    // When there is no prior runtime model, do nothing: a heartbeat turn
    // should not establish initial model state on an empty session.
  } else {
    setSessionRuntimeModel(next, {
      provider: providerUsed,
      model: modelUsed,
    });
  }
  if (!preserveUserFacingRunState) {
    if (!preserveRuntimeModel) {
      if (agentHarnessId) {
        next.agentHarnessId = agentHarnessId;
      } else if (result.meta.executionTrace?.runner === "cli") {
        next.agentHarnessId = undefined;
      }
    }
    if (!preserveRuntimeModel && isCliProvider(providerUsed, cfg)) {
      const cliSessionBinding = result.meta.agentMeta?.cliSessionBinding;
      if (result.meta.agentMeta?.clearCliSessionBinding === true) {
        clearCliSession(next, providerUsed);
      } else if (cliSessionBinding?.sessionId?.trim()) {
        setCliSessionBinding(next, providerUsed, cliSessionBinding);
      } else {
        const cliSessionId = result.meta.agentMeta?.sessionId?.trim();
        if (cliSessionId) {
          setCliSessionId(next, providerUsed, cliSessionId);
        }
      }
    }
    next.abortedLastRun = result.meta.aborted ?? false;
    clearMainSessionRecoveryAfterAgentRun(next, params.clearRestartRecoveryForceSafeTools);
    if (result.meta.systemPromptReport) {
      next.systemPromptReport = result.meta.systemPromptReport;
    }
    if (!preserveRuntimeModel) {
      next.contextBudgetStatus = contextBudgetStatus;
    }
  }
  if (hasNonzeroUsage(usage) && !preserveUserFacingRunState) {
    const { estimateUsageCost, resolveModelCostConfig } = await getUsageFormatModule();
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const totalTokens = deriveSessionTotalTokens({
      lastCallUsage,
      contextTokens,
      promptTokens,
    });
    const runEstimatedCostUsd = resolveNonNegativeNumber(
      estimateUsageCost({
        usage,
        cost: resolveModelCostConfig({
          provider: providerUsed,
          model: modelUsed,
          config: cfg,
        }),
      }),
    );
    next.inputTokens = input;
    next.outputTokens = output;
    const hasUsageTotalTokens =
      typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0;
    const useCompactionSnapshot = compactionTokensAfter !== undefined && !hasUsageTotalTokens;
    if (useCompactionSnapshot) {
      next.totalTokens = compactionTokensAfter;
      next.totalTokensFresh = true;
      next.inputTokens = undefined;
      next.outputTokens = undefined;
      next.cacheRead = undefined;
      next.cacheWrite = undefined;
      next.contextBudgetStatus = undefined;
    } else if (hasUsageTotalTokens) {
      next.totalTokens = totalTokens;
      next.totalTokensFresh = true;
    } else {
      next.totalTokens = undefined;
      next.totalTokensFresh = false;
    }
    if (!useCompactionSnapshot) {
      next.cacheRead = usage.cacheRead ?? 0;
      next.cacheWrite = usage.cacheWrite ?? 0;
    }
    // Snapshot cost like tokens (runEstimatedCostUsd is already computed from
    // cumulative run usage, so assign directly instead of accumulating).
    // Fixes #69347: cost was inflated 1x-72x by accumulating on every persist.
    if (runEstimatedCostUsd !== undefined) {
      next.estimatedCostUsd = runEstimatedCostUsd;
    }
  } else if (compactionTokensAfter !== undefined && !preserveUserFacingRunState) {
    next.totalTokens = compactionTokensAfter;
    next.totalTokensFresh = true;
    next.inputTokens = undefined;
    next.outputTokens = undefined;
    next.cacheRead = undefined;
    next.cacheWrite = undefined;
    next.contextBudgetStatus = undefined;
  } else if (
    !preserveUserFacingRunState &&
    typeof entry.totalTokens === "number" &&
    Number.isFinite(entry.totalTokens) &&
    entry.totalTokens > 0
  ) {
    next.totalTokens = entry.totalTokens;
    next.totalTokensFresh = false;
  }
  if (compactionsThisRun > 0 && !preserveUserFacingRunState) {
    next.compactionCount = (entry.compactionCount ?? 0) + compactionsThisRun;
  }
  const metadataPatch = preserveUserFacingRunState
    ? {
        // Preserved-state runs must not alter perceived session state, so the
        // unread-driving lastActivityAt stays untouched here.
        updatedAt: next.updatedAt,
        ...(touchInteraction ? { lastInteractionAt: next.lastInteractionAt } : {}),
      }
    : next;
  const maintenanceConfig = resolveMaintenanceConfigFromInput(cfg.session?.maintenance);
  const persisted = await patchSessionEntry(
    {
      storePath,
      sessionKey,
    },
    (currentEntry, context) => {
      if (
        (!context.existingEntry && hadPreExistingEntry) ||
        (!preserveUserFacingRunState &&
          context.existingEntry &&
          context.existingEntry.sessionId !== entry.sessionId)
      ) {
        // Normal runs may rotate session ids, but stale finalizers must not
        // recreate rows that were reset/deleted while the run was active.
        return null;
      }
      return preserveUserFacingRunState
        ? metadataPatch
        : projectSessionSnapshotChanges({
            initial: entry,
            next,
            current: currentEntry,
            reassertAbortedLastRun: result.meta.aborted === true,
          });
    },
    {
      ...(preserveUserFacingRunState ? {} : { fallbackEntry: entry }),
      maintenanceConfig,
    },
  );
  if (persisted) {
    sessionStore[sessionKey] = persisted;
  }
}

/** Clears a stored CLI session binding after a failed or invalidated run. */
export async function clearCliSessionInStore(params: {
  provider: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  expectedSessionId?: string;
}): Promise<SessionEntry | undefined> {
  const { provider, sessionKey, sessionStore, storePath, expectedSessionId } = params;
  const entry = sessionStore[sessionKey];
  if (!entry) {
    return undefined;
  }

  const next = { ...entry };
  clearCliSession(next, provider);
  next.updatedAt = Date.now();

  const persisted = await patchSessionEntry(
    {
      storePath,
      sessionKey,
    },
    (currentEntry, context) => {
      if (
        expectedSessionId &&
        (!context.existingEntry || currentEntry.sessionId !== expectedSessionId)
      ) {
        return null;
      }
      return next;
    },
    { fallbackEntry: entry },
  );
  if (persisted) {
    sessionStore[sessionKey] = persisted;
  }
  return persisted ?? undefined;
}

/** Clears the one-shot fork marker before the resumed CLI process starts. */
export async function consumeCliSessionForkInStore(params: {
  provider: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  expectedCliSessionId: string;
}): Promise<SessionEntry | undefined> {
  const { provider, sessionKey, sessionStore, storePath, expectedCliSessionId } = params;
  const entry = sessionStore[sessionKey];
  const binding = entry?.cliSessionBindings?.[provider];
  if (!entry || binding?.sessionId !== expectedCliSessionId || binding.forkNextResume !== true) {
    return undefined;
  }
  const persisted = await patchSessionEntry(
    { storePath, sessionKey },
    (currentEntry) => {
      const currentBinding = currentEntry.cliSessionBindings?.[provider];
      if (
        currentBinding?.sessionId !== expectedCliSessionId ||
        currentBinding.forkNextResume !== true
      ) {
        return null;
      }
      const next = { ...currentEntry };
      const { forkNextResume: _forkNextResume, ...consumedBinding } = currentBinding;
      setCliSessionBinding(next, provider, consumedBinding);
      return next;
    },
    { fallbackEntry: entry },
  );
  if (persisted) {
    sessionStore[sessionKey] = persisted;
  }
  return persisted ?? undefined;
}

/** Re-arms a claimed fork marker after a failed CLI turn. */
export async function restoreCliSessionForkInStore(params: {
  provider: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  expectedCliSessionId: string;
}): Promise<SessionEntry | undefined> {
  const { provider, sessionKey, sessionStore, storePath, expectedCliSessionId } = params;
  const entry = sessionStore[sessionKey];
  const binding = entry?.cliSessionBindings?.[provider];
  if (!entry || binding?.sessionId !== expectedCliSessionId || binding.forkNextResume === true) {
    return undefined;
  }
  const persisted = await patchSessionEntry(
    { storePath, sessionKey },
    (currentEntry) => {
      const currentBinding = currentEntry.cliSessionBindings?.[provider];
      if (
        currentBinding?.sessionId !== expectedCliSessionId ||
        currentBinding.forkNextResume === true
      ) {
        return null;
      }
      const next = { ...currentEntry };
      setCliSessionBinding(next, provider, { ...currentBinding, forkNextResume: true });
      return next;
    },
    { fallbackEntry: entry },
  );
  if (persisted) {
    sessionStore[sessionKey] = persisted;
  }
  return persisted ?? undefined;
}

/** Rebinds a claimed fork to its successor before the rest of the CLI turn can fail. */
export async function persistCliSessionForkSuccessorInStore(params: {
  provider: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  expectedCliSessionId: string;
  successorCliSessionId: string;
}): Promise<SessionEntry | undefined> {
  const {
    provider,
    sessionKey,
    sessionStore,
    storePath,
    expectedCliSessionId,
    successorCliSessionId,
  } = params;
  const entry = sessionStore[sessionKey];
  if (!entry || successorCliSessionId === expectedCliSessionId) {
    return undefined;
  }
  const persisted = await patchSessionEntry(
    { storePath, sessionKey },
    (currentEntry) => {
      const currentBinding = currentEntry.cliSessionBindings?.[provider];
      if (
        currentBinding?.sessionId !== expectedCliSessionId ||
        currentBinding.forkNextResume === true
      ) {
        return null;
      }
      const next = { ...currentEntry };
      setCliSessionBinding(next, provider, {
        ...currentBinding,
        sessionId: successorCliSessionId,
        forceReuse: true,
      });
      return next;
    },
    { fallbackEntry: entry },
  );
  if (persisted) {
    sessionStore[sessionKey] = persisted;
  }
  return persisted ?? undefined;
}

/** Records CLI compaction metadata on the persisted session entry. */
export async function recordCliCompactionInStore(params: {
  provider: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  tokensAfter?: number;
  newSessionId?: string;
  newSessionFile?: string;
  expectedSessionId?: string;
}): Promise<SessionEntry | undefined> {
  const { provider, sessionKey, sessionStore, storePath, expectedSessionId } = params;
  const entry = sessionStore[sessionKey];
  if (!entry) {
    return undefined;
  }

  const next = { ...entry };
  clearCliSession(next, provider);
  next.compactionCount = (entry.compactionCount ?? 0) + 1;
  next.updatedAt = Date.now();
  const newSessionId = normalizeOptionalString(params.newSessionId);
  const explicitNewSessionFile = normalizeOptionalString(params.newSessionFile);
  const sessionIdChanged = Boolean(newSessionId && newSessionId !== entry.sessionId);
  const sessionFileChanged = Boolean(
    explicitNewSessionFile && explicitNewSessionFile !== entry.sessionFile,
  );
  if (sessionIdChanged && newSessionId) {
    next.sessionId = newSessionId;
    next.sessionFile =
      explicitNewSessionFile ??
      resolveCompactionSessionFile({
        entry,
        sessionKey,
        storePath,
        newSessionId,
      });
    next.usageFamilyKey = entry.usageFamilyKey ?? sessionKey;
    next.usageFamilySessionIds = Array.from(
      new Set([...(entry.usageFamilySessionIds ?? []), entry.sessionId, newSessionId]),
    );
  } else if (sessionFileChanged && explicitNewSessionFile) {
    next.sessionFile = explicitNewSessionFile;
  }
  const tokensAfterCompaction = resolveNonNegativeNumber(params.tokensAfter);
  next.contextBudgetStatus = undefined;
  if (tokensAfterCompaction !== undefined) {
    next.totalTokens = Math.floor(tokensAfterCompaction);
    next.totalTokensFresh = true;
    next.inputTokens = undefined;
    next.outputTokens = undefined;
    next.cacheRead = undefined;
    next.cacheWrite = undefined;
  } else {
    next.totalTokensFresh = false;
    next.inputTokens = undefined;
    next.outputTokens = undefined;
    next.cacheRead = undefined;
    next.cacheWrite = undefined;
  }

  const persisted = await patchSessionEntry(
    {
      storePath,
      sessionKey,
    },
    (currentEntry, context) => {
      if (
        expectedSessionId &&
        (!context.existingEntry || currentEntry.sessionId !== expectedSessionId)
      ) {
        return null;
      }
      return next;
    },
    { fallbackEntry: entry },
  );
  if (persisted) {
    sessionStore[sessionKey] = persisted;
  }
  return persisted ?? undefined;
}
