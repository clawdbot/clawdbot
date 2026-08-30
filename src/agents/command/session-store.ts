/**
 * Updates persisted session metadata after agent command runs.
 */
import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  SESSION_TOTAL_TOKENS_VERSION,
  setSessionRuntimeModel,
  type SessionEntry,
} from "../../config/sessions.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { projectSessionSnapshotChanges } from "../../config/sessions/session-snapshot-merge.js";
import { resolveMaintenanceConfigFromInput } from "../../config/sessions/store-maintenance.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import {
  clearAllCliSessions,
  clearCliSession,
  getCliSessionBinding,
  setCliSessionBinding,
  setCliSessionId,
} from "../cli-session.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import type { CompactionAccountingFact } from "../embedded-agent-runner/run/internal-params.js";
import type { EmbeddedAgentCompactResult } from "../embedded-agent-runner/types.js";
import { clearMainSessionRecoveryAfterAgentRun } from "../main-session-recovery/main-session-recovery-clear.js";
import { isCliProvider } from "../model-selection.js";
import { deriveSessionTotalTokens, hasBillableUsage, hasNonzeroUsage } from "../usage.js";

type RunResult = Awaited<ReturnType<(typeof import("../embedded-agent.js"))["runEmbeddedAgent"]>>;

const getUsageFormatModule = createLazyPromise(() => import("../../utils/usage-format.js"));
const getContextModule = createLazyPromise(() => import("../context.js"));

export function normalizeSessionTokenCount(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

/** Applies run result metadata, usage, and CLI bindings to a session entry. */
export async function updateSessionStoreAfterAgentRun(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  sessionStore: Record<string, SessionEntry>;
  defaultProvider: string;
  defaultModel: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  result: RunResult;
  /** Private committed owner and ordered context; an unknown snapshot invalidates older usage. */
  compactionAccounting?: Extract<CompactionAccountingFact, { kind: "durable" }>;
  touchInteraction?: boolean;
  /**
   * When false, skip the lastActivityAt bump so heartbeat/internal-event runs
   * do not re-flag sessions unread; cron and user-facing runs count as activity.
   */
  touchActivity?: boolean;
  /**
   * When true, preserve the pre-existing runtime model fields (model,
   * modelProvider, contextTokens) on the session entry instead of overwriting
   * them with the model used by this run. Used for turn-local fallback and
   * heartbeat runs so their model does not bleed into the session selection.
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
  const modelUsed = result.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
  const providerUsed = result.meta.agentMeta?.provider ?? fallbackProvider ?? defaultProvider;
  const agentHarnessId = normalizeOptionalString(result.meta.agentMeta?.agentHarnessId);
  const runtimeContextTokens = normalizeSessionTokenCount(result.meta.agentMeta?.contextTokens);
  const contextBudgetStatus = result.meta.agentMeta?.contextBudgetStatus;
  const contextTokens =
    runtimeContextTokens !== undefined
      ? runtimeContextTokens
      : ((await getContextModule()).resolveContextTokensForModel({
          cfg,
          provider: providerUsed,
          model: modelUsed,
          fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
          allowAsyncLoad: false,
        }) ?? DEFAULT_CONTEXT_TOKENS);
  const contextTokensSource = result.meta.agentMeta?.contextTokensSource ?? "resolved";

  const preserveUserFacingRunState = params.preserveUserFacingSessionModelState === true;
  const preserveRuntimeModel = params.preserveRuntimeModel === true || preserveUserFacingRunState;
  const hadPreExistingEntry = sessionStore[sessionKey] !== undefined;
  const entry: InternalSessionEntry = sessionStore[sessionKey] ?? {
    sessionId,
    updatedAt: now,
    sessionStartedAt: now,
  };
  const expectedSession = params.compactionAccounting?.target ?? entry;
  if (!preserveUserFacingRunState && expectedSession.sessionId !== sessionId) {
    return;
  }
  const next: SessionEntry = {
    ...entry,
    updatedAt: now,
    sessionStartedAt: entry.sessionStartedAt ?? now,
    lastInteractionAt: touchInteraction ? now : entry.lastInteractionAt,
    lastActivityAt: touchActivity ? now : entry.lastActivityAt,
    ...(preserveRuntimeModel
      ? {}
      : {
          contextTokens,
          contextTokensSource,
        }),
  };
  if (preserveRuntimeModel) {
    // Keep the pre-existing runtime model and context window so a turn-local
    // model does not bleed into the session's perceived selection.
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
      next.agentHarnessId = agentHarnessId;
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
  const hasUsage = hasNonzeroUsage(usage);
  if (hasBillableUsage(usage) && !preserveUserFacingRunState) {
    const { estimateAggregateUsageCost, resolveModelCostConfig } = await getUsageFormatModule();
    const runEstimatedCostUsd = asNonNegativeFiniteNumber(
      estimateAggregateUsageCost({
        usage,
        cost: resolveModelCostConfig({
          provider: providerUsed,
          model: modelUsed,
          config: cfg,
          agentDir: params.agentDir,
        }),
      }),
    );
    if (hasUsage) {
      next.inputTokens = usage.input ?? 0;
      next.outputTokens = usage.output ?? 0;
      next.cacheRead = usage.cacheRead ?? 0;
      next.cacheWrite = usage.cacheWrite ?? 0;
    }
    // Snapshot cumulative run cost once, independently of current context.
    // Unknown current cost must clear the previous run's snapshot too.
    next.estimatedCostUsd = runEstimatedCostUsd;
  }
  if (!preserveUserFacingRunState) {
    const currentContextSnapshot = params.compactionAccounting?.currentContextSnapshot;
    if (currentContextSnapshot || hasUsage) {
      const totalTokens = currentContextSnapshot
        ? currentContextSnapshot.tokens
        : deriveSessionTotalTokens({ lastCallUsage, contextTokens, promptTokens });
      next.totalTokens = totalTokens;
      next.totalTokensFresh = totalTokens !== undefined;
      next.totalTokensVersion =
        totalTokens !== undefined ? SESSION_TOTAL_TOKENS_VERSION : undefined;
    } else if (
      typeof entry.totalTokens === "number" &&
      Number.isFinite(entry.totalTokens) &&
      entry.totalTokens > 0
    ) {
      next.totalTokensFresh = false;
      next.totalTokensVersion = undefined;
    }
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
  await patchSessionEntryCore(
    {
      storePath,
      sessionKey,
    },
    (currentEntry, context) => {
      if (
        (!context.existingEntry && hadPreExistingEntry) ||
        (!preserveUserFacingRunState &&
          context.existingEntry &&
          (context.existingEntry.sessionId !== expectedSession.sessionId ||
            context.existingEntry.lifecycleRevision !== expectedSession.lifecycleRevision ||
            context.existingEntry.activeWriterRunId !== expectedSession.activeWriterRunId))
      ) {
        // Successor acceptance owns identity changes. Finalizers may update only
        // their exact still-current row and cannot recreate a deleted owner.
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
      ...(preserveUserFacingRunState || params.compactionAccounting
        ? {}
        : { fallbackEntry: entry }),
      maintenanceConfig,
      onCommitted: (committed) => {
        // Maintenance may yield to a newer writer before the patch promise returns.
        sessionStore[sessionKey] = committed;
      },
    },
  );
}

/** Clears a stored CLI session binding after a failed or invalidated run. */
export async function clearCliSessionInStore(params: {
  provider: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  expectedSessionId?: string;
  expectedCliSessionId?: string;
}): Promise<SessionEntry | undefined> {
  const { provider, sessionKey, sessionStore, storePath, expectedSessionId, expectedCliSessionId } =
    params;
  const entry = sessionStore[sessionKey];
  if (!entry) {
    return undefined;
  }

  let didClear = false;
  const persisted = await patchSessionEntryCore(
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
      if (
        expectedCliSessionId &&
        getCliSessionBinding(currentEntry, provider)?.sessionId !== expectedCliSessionId
      ) {
        return null;
      }
      const next = { ...currentEntry };
      clearCliSession(next, provider);
      next.updatedAt = Date.now();
      didClear = true;
      return next;
    },
    { fallbackEntry: entry },
  );
  if (persisted && didClear) {
    sessionStore[sessionKey] = persisted;
    return persisted;
  }
  return undefined;
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
  const persisted = await patchSessionEntryCore(
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

/** Arms a fork marker for recovery, or re-arms one after a failed CLI turn. */
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
  const persisted = await patchSessionEntryCore(
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
  const persisted = await patchSessionEntryCore(
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
  compactionKind: NonNullable<EmbeddedAgentCompactResult["compactionKind"]>;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  tokensAfter?: number;
  expectedSession: Pick<
    InternalSessionEntry,
    "sessionId" | "lifecycleRevision" | "activeWriterRunId"
  >;
}): Promise<SessionEntry | undefined> {
  const { compactionKind, sessionKey, sessionStore, storePath, expectedSession } = params;
  const entry = sessionStore[sessionKey];
  if (!entry) {
    return undefined;
  }

  const next = { ...entry };
  // A shared-history rewrite invalidates every binding; native compaction preserves its session.
  if (compactionKind === "context-engine") {
    clearAllCliSessions(next);
  }
  next.compactionCount = (entry.compactionCount ?? 0) + 1;
  next.updatedAt = Date.now();
  const tokensAfterCompaction = asNonNegativeFiniteNumber(params.tokensAfter);
  next.contextBudgetStatus = undefined;
  next.inputTokens = undefined;
  next.outputTokens = undefined;
  next.cacheRead = undefined;
  next.cacheWrite = undefined;
  if (tokensAfterCompaction !== undefined) {
    next.totalTokens = Math.floor(tokensAfterCompaction);
    next.totalTokensFresh = true;
    next.totalTokensVersion = SESSION_TOTAL_TOKENS_VERSION;
  } else {
    next.totalTokensFresh = false;
    next.totalTokensVersion = undefined;
  }

  let committedEntry: SessionEntry | undefined;
  await patchSessionEntryCore(
    {
      storePath,
      sessionKey,
    },
    (currentEntry, context) => {
      if (
        !context.existingEntry ||
        currentEntry.sessionId !== expectedSession.sessionId ||
        currentEntry.lifecycleRevision !== expectedSession.lifecycleRevision ||
        currentEntry.activeWriterRunId !== expectedSession.activeWriterRunId
      ) {
        return null;
      }
      return {
        ...currentEntry,
        ...projectSessionSnapshotChanges({ initial: entry, next, current: currentEntry }),
        compactionCount: (currentEntry.compactionCount ?? 0) + 1,
      };
    },
    {
      onCommitted: (committed) => {
        // Retain the committed fact without overwriting a later writer's cache on return.
        committedEntry = committed;
        sessionStore[sessionKey] = committed;
      },
    },
  );
  return committedEntry;
}
