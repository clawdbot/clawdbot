import path from "node:path";
import {
  canonicalizeAbsoluteSessionFilePath,
  mergeSessionEntry,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  setSessionRuntimeModel,
  type SessionEntry,
  updateSessionStore,
  rewriteSessionFileForNewSessionId,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { clearCliSession, setCliSessionBinding, setCliSessionId } from "../cli-session.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { isCliProvider } from "../model-selection.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../usage.js";

type RunResult = Awaited<ReturnType<(typeof import("../pi-embedded.js"))["runEmbeddedPiAgent"]>>;

const usageFormatModuleLoader = createLazyImportLoader(() => import("../../utils/usage-format.js"));
const contextModuleLoader = createLazyImportLoader(() => import("../context.js"));

async function getUsageFormatModule() {
  return await usageFormatModuleLoader.load();
}

async function getContextModule() {
  return await contextModuleLoader.load();
}

function resolveNonNegativeNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function resolvePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function removeLifecycleStateFromMetadataPatch(entry: SessionEntry): SessionEntry {
  const next = { ...entry };
  delete next.status;
  delete next.startedAt;
  delete next.endedAt;
  delete next.runtimeMs;
  return next;
}

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
   * When true, preserve the pre-existing runtime model fields (model,
   * modelProvider, contextTokens) on the session entry instead of overwriting
   * them with the model used by this run. Used for heartbeat turns so the
   * heartbeat model does not "bleed" into the main session's perceived state.
   */
  preserveRuntimeModel?: boolean;
  preserveUserFacingSessionModelState?: boolean;
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
  const runtimeContextTokens = resolvePositiveInteger(result.meta.agentMeta?.contextTokens);
  const contextBudgetStatus = result.meta.agentMeta?.contextBudgetStatus;
  const contextTokens =
    runtimeContextTokens !== undefined
      ? runtimeContextTokens
      : typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0
        ? params.contextTokensOverride
        : ((await getContextModule()).resolveContextTokensForModel({
            cfg,
            provider: providerUsed,
            model: modelUsed,
            fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
            allowAsyncLoad: false,
          }) ?? DEFAULT_CONTEXT_TOKENS);

  const preserveUserFacingRunState = params.preserveUserFacingSessionModelState === true;
  const preserveRuntimeModel = params.preserveRuntimeModel === true || preserveUserFacingRunState;
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
    ...(preserveRuntimeModel
      ? {}
      : {
          contextTokens,
        }),
  };
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
    if (agentHarnessId) {
      next.agentHarnessId = agentHarnessId;
    } else if (result.meta.executionTrace?.runner === "cli") {
      next.agentHarnessId = undefined;
    }
    if (isCliProvider(providerUsed, cfg)) {
      const cliSessionBinding = result.meta.agentMeta?.cliSessionBinding;
      if (cliSessionBinding?.sessionId?.trim()) {
        setCliSessionBinding(next, providerUsed, cliSessionBinding);
      } else {
        const cliSessionId = result.meta.agentMeta?.sessionId?.trim();
        if (cliSessionId) {
          setCliSessionId(next, providerUsed, cliSessionId);
        }
      }
    }
    next.abortedLastRun = result.meta.aborted ?? false;
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
    const usageForContext = isCliProvider(providerUsed, cfg)
      ? promptTokens
        ? undefined
        : lastCallUsage
      : usage;
    const totalTokens = deriveSessionTotalTokens({
      usage: promptTokens ? undefined : usageForContext,
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
    if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
      next.totalTokens = totalTokens;
      next.totalTokensFresh = true;
    } else if (compactionTokensAfter !== undefined) {
      next.totalTokens = compactionTokensAfter;
      next.totalTokensFresh = true;
    } else {
      next.totalTokens = undefined;
      next.totalTokensFresh = false;
    }
    next.cacheRead = usage.cacheRead ?? 0;
    next.cacheWrite = usage.cacheWrite ?? 0;
    // Snapshot cost like tokens (runEstimatedCostUsd is already computed from
    // cumulative run usage, so assign directly instead of accumulating).
    // Fixes #69347: cost was inflated 1x-72x by accumulating on every persist.
    if (runEstimatedCostUsd !== undefined) {
      next.estimatedCostUsd = runEstimatedCostUsd;
    }
  } else if (compactionTokensAfter !== undefined && !preserveUserFacingRunState) {
    next.totalTokens = compactionTokensAfter;
    next.totalTokensFresh = true;
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
        updatedAt: next.updatedAt,
        ...(touchInteraction ? { lastInteractionAt: next.lastInteractionAt } : {}),
      }
    : removeLifecycleStateFromMetadataPatch(next);
  const persisted = await updateSessionStore(storePath, (store) => {
    if (preserveUserFacingRunState && !store[sessionKey]) {
      return undefined;
    }
    const merged = mergeSessionEntry(store[sessionKey], metadataPatch);
    store[sessionKey] = merged;
    return merged;
  });
  if (persisted) {
    sessionStore[sessionKey] = persisted;
  }
}

export async function clearCliSessionInStore(params: {
  provider: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
}): Promise<SessionEntry | undefined> {
  const { provider, sessionKey, sessionStore, storePath } = params;
  const entry = sessionStore[sessionKey];
  if (!entry) {
    return undefined;
  }

  const next = { ...entry };
  clearCliSession(next, provider);
  next.updatedAt = Date.now();

  const persisted = await updateSessionStore(storePath, (store) => {
    const merged = mergeSessionEntry(store[sessionKey], next);
    store[sessionKey] = merged;
    return merged;
  });
  sessionStore[sessionKey] = persisted;
  return persisted;
}

export async function recordCliCompactionInStore(params: {
  provider: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  tokensAfter?: number;
  newSessionId?: string;
  newSessionFile?: string;
}): Promise<SessionEntry | undefined> {
  const { provider, sessionKey, sessionStore, storePath } = params;
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

  const persisted = await updateSessionStore(storePath, (store) => {
    const merged = mergeSessionEntry(store[sessionKey], next);
    store[sessionKey] = merged;
    return merged;
  });
  sessionStore[sessionKey] = persisted;
  return persisted;
}

function resolveCompactionSessionFile(params: {
  entry: SessionEntry;
  sessionKey: string;
  storePath?: string;
  newSessionId: string;
}): string {
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const pathOpts = resolveSessionFilePathOptions({
    agentId,
    storePath: params.storePath,
  });
  const rewrittenSessionFile = rewriteSessionFileForNewSessionId({
    sessionFile: params.entry.sessionFile,
    previousSessionId: params.entry.sessionId,
    nextSessionId: params.newSessionId,
  });
  const normalizedRewrittenSessionFile =
    rewrittenSessionFile && path.isAbsolute(rewrittenSessionFile)
      ? canonicalizeAbsoluteSessionFilePath(rewrittenSessionFile)
      : rewrittenSessionFile;
  return resolveSessionFilePath(
    params.newSessionId,
    normalizedRewrittenSessionFile ? { sessionFile: normalizedRewrittenSessionFile } : undefined,
    pathOpts,
  );
}
