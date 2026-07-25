import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeActiveMemoryFastMode } from "./config.js";
import { getModelRef } from "./query.js";
import { runRecallSubagent } from "./recall-run.js";
import {
  buildCacheKey,
  buildCircuitBreakerKey,
  getCachedResult,
  isCircuitBreakerOpen,
  recordCircuitBreakerTimeout,
  resetCircuitBreaker,
  scheduleMemorySearchCleanupAfterTimeout,
  setCachedResult,
  shouldCacheResult,
  toSingleLineLogValue,
} from "./recall-state.js";
import {
  buildPersistedDebugSummary,
  buildPluginStatusLine,
  persistPluginStatusLines,
  resolveCanonicalSessionKeyFromSessionId,
} from "./session.js";
import {
  buildSubagentRecallResult,
  buildTimeoutRecallResult,
  readPartialTimeoutData,
} from "./transcript-result.js";
import { watchTerminalMemorySearchResult } from "./transcript-watch.js";
import type {
  ActiveMemorySearchDebug,
  ActiveMemoryFastMode,
  ActiveMemoryTranscriptSource,
  ActiveRecallResult,
  ConversationRecallContext,
  ResolvedActiveRecallPluginConfig,
  TerminalMemorySearchWatch,
} from "./types.js";

function formatActiveMemoryFastMode(fastMode: ActiveMemoryFastMode | undefined): string {
  return fastMode === undefined
    ? "inherit"
    : fastMode === true
      ? "on"
      : fastMode === false
        ? "off"
        : "auto";
}

function prepareRecallRunContext(params: {
  api: OpenClawPluginApi;
  runtimeConfig: OpenClawConfig;
  config: ResolvedActiveRecallPluginConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
}): {
  parentSessionKey?: string;
  storePath: string;
  fastMode?: ActiveMemoryFastMode;
} {
  const parentSessionKey =
    params.sessionKey ??
    resolveCanonicalSessionKeyFromSessionId({
      api: params.api,
      agentId: params.agentId,
      sessionId: params.sessionId,
    });
  const storePath = params.api.runtime.agent.session.resolveStorePath(
    params.runtimeConfig.session?.store,
    { agentId: params.agentId },
  );
  if (params.config.fastMode !== undefined) {
    return { parentSessionKey, storePath, fastMode: params.config.fastMode };
  }
  const sessionFastMode = parentSessionKey
    ? params.api.runtime.agent.session.getSessionEntry({
        agentId: params.agentId,
        sessionKey: parentSessionKey,
        storePath,
        readConsistency: "latest",
      })?.fastMode
    : undefined;
  const fastMode =
    normalizeActiveMemoryFastMode(sessionFastMode) ??
    normalizeActiveMemoryFastMode(
      resolveAgentConfig(params.runtimeConfig, params.agentId)?.fastModeDefault,
    );
  return { parentSessionKey, storePath, fastMode };
}

async function maybeResolveActiveRecall(params: {
  api: OpenClawPluginApi;
  runtimeConfig: OpenClawConfig;
  config: ResolvedActiveRecallPluginConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  channelId?: string;
  query: string;
  searchQuery: string;
  currentModelProviderId?: string;
  currentModelId?: string;
  conversationRecall?: ConversationRecallContext;
  abortSignal?: AbortSignal;
}): Promise<ActiveRecallResult> {
  params.abortSignal?.throwIfAborted();
  const startedAt = Date.now();
  // Memory Core re-authorizes every conversation-recall request against live
  // session state. Never replay a cached private summary after eligibility changes.
  const cacheKey = params.conversationRecall
    ? undefined
    : buildCacheKey({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        query: params.query,
      });
  const cached = cacheKey ? getCachedResult(cacheKey) : undefined;
  const resolvedModelRef = getModelRef(params.runtimeConfig, params.agentId, params.config, {
    modelProviderId: params.currentModelProviderId,
    modelId: params.currentModelId,
  });
  const buildLogPrefix = (fastMode: ActiveMemoryFastMode | undefined) =>
    [
      `active-memory: agent=${toSingleLineLogValue(params.agentId)}`,
      `session=${toSingleLineLogValue(params.sessionKey ?? params.sessionId ?? "none")}`,
      ...(resolvedModelRef?.provider
        ? [`activeProvider=${toSingleLineLogValue(resolvedModelRef.provider)}`]
        : []),
      ...(resolvedModelRef?.model
        ? [`activeModel=${toSingleLineLogValue(resolvedModelRef.model)}`]
        : []),
      `thinking=${params.config.thinking}`,
      `fast=${formatActiveMemoryFastMode(fastMode)}`,
    ].join(" ");
  let logPrefix = buildLogPrefix(params.config.fastMode);
  if (cached) {
    params.abortSignal?.throwIfAborted();
    await persistPluginStatusLines({
      api: params.api,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      statusLine: `${buildPluginStatusLine({ result: cached, config: params.config })} cached`,
      debugSummary: buildPersistedDebugSummary(cached),
      searchDebug: cached.searchDebug,
    });
    params.abortSignal?.throwIfAborted();
    if (params.config.logging) {
      params.api.logger.info?.(
        `${logPrefix} cached status=${cached.status} summaryChars=${String(cached.summary?.length ?? 0)} queryChars=${String(params.query.length)}`,
      );
    }
    return cached;
  }

  // Circuit breaker: skip recall when the same agent/model has timed out
  // too many times in a row (#74054).
  const cbKey = buildCircuitBreakerKey(
    params.agentId,
    resolvedModelRef?.provider,
    resolvedModelRef?.model,
  );
  let timeoutCleanupScheduled = false;
  const scheduleTimeoutCleanup = () => {
    if (timeoutCleanupScheduled) {
      return;
    }
    timeoutCleanupScheduled = true;
    scheduleMemorySearchCleanupAfterTimeout(params.api, logPrefix, params.agentId);
  };
  let circuitBreakerTimeoutRecorded = false;
  const recordRecallTimeout = () => {
    if (!circuitBreakerTimeoutRecorded) {
      circuitBreakerTimeoutRecorded = true;
      recordCircuitBreakerTimeout(cbKey);
    }
    scheduleTimeoutCleanup();
  };
  if (
    isCircuitBreakerOpen(
      cbKey,
      params.config.circuitBreakerMaxTimeouts,
      params.config.circuitBreakerCooldownMs,
    )
  ) {
    const result: ActiveRecallResult = {
      status: "timeout",
      elapsedMs: 0,
      summary: null,
    };
    if (params.config.logging) {
      params.api.logger.info?.(
        `${logPrefix} skipped (circuit breaker open after consecutive timeouts)`,
      );
    }
    params.abortSignal?.throwIfAborted();
    await persistPluginStatusLines({
      api: params.api,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      statusLine: `${buildPluginStatusLine({ result, config: params.config })} circuit-breaker`,
    });
    return result;
  }

  const runContext = prepareRecallRunContext(params);
  logPrefix = buildLogPrefix(runContext.fastMode);

  if (params.config.logging) {
    params.api.logger.info?.(
      `${logPrefix} start timeoutMs=${String(params.config.timeoutMs)} queryChars=${String(
        params.query.length,
      )} searchQueryChars=${String(params.searchQuery.length)}`,
    );
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(params.abortSignal?.reason);
  params.abortSignal?.addEventListener("abort", abortFromParent, { once: true });
  if (params.abortSignal?.aborted) {
    abortFromParent();
  }
  const TIMEOUT_SENTINEL = Symbol("timeout");
  let transcriptSources: readonly ActiveMemoryTranscriptSource[] = [];
  let recallTimedOut = false;
  const watchdogTimeoutMs = params.config.timeoutMs + params.config.setupGraceTimeoutMs;
  const timeoutId = setTimeout(() => {
    if (params.abortSignal?.aborted) {
      return;
    }
    recallTimedOut = true;
    controller.abort(new Error(`active-memory timeout after ${watchdogTimeoutMs}ms`));
  }, watchdogTimeoutMs);
  timeoutId.unref?.();

  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        resolve(TIMEOUT_SENTINEL);
      },
      { once: true },
    );
  });

  let terminalMemorySearchWatch: TerminalMemorySearchWatch | undefined;
  let recallInFlight = false;
  try {
    recallInFlight = true;
    const subagentPromise = runRecallSubagent({
      ...params,
      modelRef: resolvedModelRef,
      parentSessionKey: runContext.parentSessionKey,
      storePath: runContext.storePath,
      fastMode: runContext.fastMode,
      abortSignal: controller.signal,
      onTranscriptSources: (sources) => {
        transcriptSources = sources;
      },
    });
    terminalMemorySearchWatch = watchTerminalMemorySearchResult({
      getTranscriptSources: () => transcriptSources,
      abortSignal: controller.signal,
      toolsAllow: params.config.toolsAllow,
    });
    // Silently catch late rejections after timeout so they don't become
    // unhandled promise rejections.
    subagentPromise.catch(() => undefined);

    let raceResult = await Promise.race([
      subagentPromise,
      timeoutPromise,
      terminalMemorySearchWatch.promise,
    ]);
    terminalMemorySearchWatch.stop();
    let fallbackSearchDebug: ActiveMemorySearchDebug | undefined;
    let fallbackHasUsableMemoryResult = false;
    if (
      raceResult !== TIMEOUT_SENTINEL &&
      "status" in raceResult &&
      raceResult.hasUsableMemoryResult
    ) {
      // A later unavailable call must not discard a summary grounded in an
      // earlier successful recall. The existing watchdog remains the deadline.
      fallbackSearchDebug = raceResult.searchDebug;
      fallbackHasUsableMemoryResult = true;
      raceResult = await Promise.race([subagentPromise, timeoutPromise]);
    }
    if (raceResult !== TIMEOUT_SENTINEL) {
      recallInFlight = false;
    }

    if (raceResult === TIMEOUT_SENTINEL) {
      if (recallTimedOut) {
        recordRecallTimeout();
      } else if (params.abortSignal?.aborted && recallInFlight) {
        scheduleTimeoutCleanup();
      }
      const elapsedMs = Date.now() - startedAt;
      const result: ActiveRecallResult = fallbackHasUsableMemoryResult
        ? {
            status: "timeout",
            elapsedMs,
            summary: null,
            searchDebug: fallbackSearchDebug,
          }
        : await buildTimeoutRecallResult({
            elapsedMs,
            maxSummaryChars: params.config.maxSummaryChars,
            transcriptSources,
            subagentPromise,
            toolsAllow: params.config.toolsAllow,
          });
      if (params.config.logging) {
        params.api.logger.info?.(
          `${logPrefix} done status=${result.status} elapsedMs=${String(result.elapsedMs)} summaryChars=${String(result.summary?.length ?? 0)}`,
        );
      }
      params.abortSignal?.throwIfAborted();
      await persistPluginStatusLines({
        api: params.api,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        statusLine: buildPluginStatusLine({ result, config: params.config }),
        debugSummary: buildPersistedDebugSummary(result),
        searchDebug: result.searchDebug,
      });
      params.abortSignal?.throwIfAborted();
      return result;
    }

    if ("status" in raceResult) {
      controller.abort(new Error("active-memory terminal memory search result"));
      const result: ActiveRecallResult = {
        status: raceResult.status,
        elapsedMs: Date.now() - startedAt,
        summary: null,
        searchDebug: raceResult.searchDebug,
      };
      if (params.config.logging) {
        params.api.logger.info?.(
          `${logPrefix} done status=${result.status} elapsedMs=${String(result.elapsedMs)} summaryChars=${String(result.summary?.length ?? 0)}`,
        );
      }
      resetCircuitBreaker(cbKey);
      params.abortSignal?.throwIfAborted();
      await persistPluginStatusLines({
        api: params.api,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        statusLine: buildPluginStatusLine({ result, config: params.config }),
        searchDebug: result.searchDebug,
      });
      params.abortSignal?.throwIfAborted();
      if (cacheKey && shouldCacheResult(result)) {
        setCachedResult(cacheKey, result, params.config.cacheTtlMs);
      }
      return result;
    }

    const { transcriptPath } = raceResult;
    if (params.config.logging && transcriptPath) {
      params.api.logger.info?.(`${logPrefix} transcript=${transcriptPath}`);
    }
    const result = buildSubagentRecallResult({
      subagentResult: raceResult,
      fallbackSearchDebug,
      fallbackHasUsableMemoryResult,
      elapsedMs: Date.now() - startedAt,
      maxSummaryChars: params.config.maxSummaryChars,
    });
    if (params.config.logging) {
      params.api.logger.info?.(
        `${logPrefix} done status=${result.status} elapsedMs=${String(result.elapsedMs)} summaryChars=${String(result.summary?.length ?? 0)}`,
      );
    }
    resetCircuitBreaker(cbKey);
    params.abortSignal?.throwIfAborted();
    await persistPluginStatusLines({
      api: params.api,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      statusLine: buildPluginStatusLine({ result, config: params.config }),
      debugSummary: buildPersistedDebugSummary(result),
      searchDebug: result.searchDebug,
    });
    params.abortSignal?.throwIfAborted();
    if (cacheKey && shouldCacheResult(result)) {
      setCachedResult(cacheKey, result, params.config.cacheTtlMs);
    }
    return result;
  } catch (error) {
    if (params.abortSignal?.aborted) {
      if (recallTimedOut) {
        recordRecallTimeout();
      } else if (recallInFlight) {
        scheduleTimeoutCleanup();
      }
      params.abortSignal.throwIfAborted();
    }
    if (controller.signal.aborted) {
      if (recallTimedOut) {
        recordRecallTimeout();
      }
      const partialTimeoutData = readPartialTimeoutData(error);
      const result = await buildTimeoutRecallResult({
        elapsedMs: Date.now() - startedAt,
        maxSummaryChars: params.config.maxSummaryChars,
        transcriptSources,
        rawReply: partialTimeoutData.rawReply,
        searchDebug: partialTimeoutData.searchDebug,
        hasUnavailableMemorySearchResult: partialTimeoutData.hasUnavailableMemorySearchResult,
        toolsAllow: params.config.toolsAllow,
      });
      if (params.config.logging) {
        params.api.logger.info?.(
          `${logPrefix} done status=${result.status} elapsedMs=${String(result.elapsedMs)} summaryChars=${String(result.summary?.length ?? 0)}`,
        );
      }
      params.abortSignal?.throwIfAborted();
      await persistPluginStatusLines({
        api: params.api,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        statusLine: buildPluginStatusLine({ result, config: params.config }),
        debugSummary: buildPersistedDebugSummary(result),
        searchDebug: result.searchDebug,
      });
      params.abortSignal?.throwIfAborted();
      return result;
    }
    const message = toSingleLineLogValue(error instanceof Error ? error.message : String(error));
    if (params.config.logging) {
      params.api.logger.warn?.(`${logPrefix} failed error=${message}; skipping recall`);
    }
    const result: ActiveRecallResult = {
      status: "failed",
      elapsedMs: Date.now() - startedAt,
      summary: null,
    };
    params.abortSignal?.throwIfAborted();
    await persistPluginStatusLines({
      api: params.api,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      statusLine: buildPluginStatusLine({ result, config: params.config }),
      searchDebug: result.searchDebug,
    });
    return result;
  } finally {
    params.abortSignal?.removeEventListener("abort", abortFromParent);
    terminalMemorySearchWatch?.stop();
    clearTimeout(timeoutId);
  }
}

export { maybeResolveActiveRecall };
