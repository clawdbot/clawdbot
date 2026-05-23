import {
  compactContextEngineWithSafetyTimeout,
  embeddedAgentLog,
  formatErrorMessage,
  isActiveHarnessContextEngine,
  resolveCompactionTimeoutMs,
  resolveContextEngineOwnerPluginId,
  runHarnessContextEngineMaintenance,
  type CompactEmbeddedPiSessionParams,
  type EmbeddedPiCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  defaultCodexAppServerClientFactory,
  type CodexAppServerClientFactory,
} from "./client-factory.js";
import type { CodexAppServerClient, CodexServerNotificationHandler } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { isJsonObject, type CodexServerNotification, type JsonObject } from "./protocol.js";
import { resolveCodexNativeExecutionBlock } from "./sandbox-guard.js";
import { clearCodexAppServerBinding, readCodexAppServerBinding } from "./session-binding.js";
type CodexNativeCompactionCompletion = {
  signal: "thread/compacted" | "item/completed";
  turnId?: string;
  itemId?: string;
  tokensAfter?: number;
};
type CodexNativeCompactionWaiter = {
  promise: Promise<CodexNativeCompactionCompletion>;
  startTimeout: () => void;
  cancel: () => void;
};

const DEFAULT_CODEX_COMPACTION_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const CODEX_COMPACTION_TOKEN_USAGE_GRACE_MS = 250;
const MAX_CODEX_NATIVE_COMPACTION_ATTEMPTS = 2;
const warnedIgnoredCompactionOverrides = new Set<string>();

class CodexNativeCompactionTimeoutError extends Error {
  constructor(readonly threadId: string) {
    super(`timed out waiting for codex app-server compaction for ${threadId}`);
  }
}

export async function maybeCompactCodexAppServerSession(
  params: CompactEmbeddedPiSessionParams,
  options: { pluginConfig?: unknown; clientFactory?: CodexAppServerClientFactory } = {},
): Promise<EmbeddedPiCompactResult | undefined> {
  const activeContextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;
  if (activeContextEngine?.info.ownsCompaction) {
    return await compactOwningContextEngine(params, activeContextEngine);
  }
  warnIfIgnoringOpenClawCompactionOverrides(params);
  const nativeResult = await compactCodexNativeThread(params, options);
  if (activeContextEngine && nativeResult?.ok && nativeResult.compacted) {
    try {
      await runHarnessContextEngineMaintenance({
        contextEngine: activeContextEngine,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        reason: "compaction",
        runtimeContext: params.contextEngineRuntimeContext,
        config: params.config,
      });
    } catch (error) {
      embeddedAgentLog.warn("context engine compaction maintenance failed after Codex compaction", {
        sessionId: params.sessionId,
        engineId: activeContextEngine.info.id,
        error: formatErrorMessage(error),
      });
    }
  }
  return nativeResult;
}

async function compactOwningContextEngine(
  params: CompactEmbeddedPiSessionParams,
  contextEngine: NonNullable<CompactEmbeddedPiSessionParams["contextEngine"]>,
): Promise<EmbeddedPiCompactResult> {
  const compactionTarget = params.trigger === "manual" ? "threshold" : "budget";
  const force = params.force === true || params.trigger === "manual";
  embeddedAgentLog.info("starting context-engine-owned Codex app-server compaction", {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    engineId: contextEngine.info.id,
    tokenBudget: params.contextTokenBudget,
    currentTokenCount: params.currentTokenCount,
    trigger: params.trigger,
    compactionTarget,
    force,
  });
  let result: Awaited<ReturnType<typeof contextEngine.compact>>;
  try {
    // Bound the plugin-owned compaction with the same finite safety timeout
    // that protects native runtime compaction, and thread the caller's abort
    // signal through, so a slow/hung plugin compact() cannot hang the Codex
    // compaction lane indefinitely. A timeout/abort (or any thrown error) is
    // converted to a clean { ok: false } result by the catch below.
    result = await compactContextEngineWithSafetyTimeout(
      contextEngine,
      {
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        tokenBudget: params.contextTokenBudget,
        currentTokenCount: params.currentTokenCount,
        compactionTarget,
        customInstructions: params.customInstructions,
        force,
        runtimeContext: params.contextEngineRuntimeContext,
      },
      resolveCompactionTimeoutMs(params.config),
      params.abortSignal,
    );
  } catch (error) {
    embeddedAgentLog.warn("context-engine-owned Codex app-server compaction failed", {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      engineId: contextEngine.info.id,
      error: formatErrorMessage(error),
    });
    return {
      ok: false,
      compacted: false,
      reason: `context engine compaction failed: ${formatErrorMessage(error)}`,
    };
  }

  if (result.ok && result.compacted) {
    const compactedSessionId = result.result?.sessionId ?? params.sessionId;
    const compactedSessionFile = result.result?.sessionFile ?? params.sessionFile;
    try {
      await runHarnessContextEngineMaintenance({
        contextEngine,
        sessionId: compactedSessionId,
        sessionKey: params.sessionKey,
        sessionFile: compactedSessionFile,
        reason: "compaction",
        runtimeContext: params.contextEngineRuntimeContext,
        config: params.config,
      });
    } catch (error) {
      embeddedAgentLog.warn("context engine compaction maintenance failed", {
        sessionId: compactedSessionId,
        engineId: contextEngine.info.id,
        error: formatErrorMessage(error),
      });
    }
    await clearCodexAppServerBinding(params.sessionFile, { config: params.config });
    if (compactedSessionFile !== params.sessionFile) {
      await clearCodexAppServerBinding(compactedSessionFile, { config: params.config });
    }
  }

  embeddedAgentLog.info("completed context-engine-owned Codex app-server compaction", {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    engineId: contextEngine.info.id,
    ok: result.ok,
    compacted: result.compacted,
    reason: result.reason,
    codexThreadBindingInvalidated: result.ok && result.compacted,
  });
  return {
    ok: result.ok,
    compacted: result.compacted,
    reason: result.reason,
    result: result.result
      ? {
          ...result.result,
          summary: result.result.summary ?? "",
          firstKeptEntryId: result.result.firstKeptEntryId ?? "",
          details: mergeContextEngineCompactionDetails(result.result.details, {
            codexThreadBindingInvalidated: result.ok && result.compacted,
          }),
        }
      : result.ok && result.compacted
        ? {
            summary: "",
            firstKeptEntryId: "",
            tokensBefore: params.currentTokenCount ?? 0,
            details: { codexThreadBindingInvalidated: true },
          }
        : undefined,
  };
}

function mergeContextEngineCompactionDetails(
  details: unknown,
  extra: Record<string, unknown>,
): unknown {
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return {
      ...(details as Record<string, unknown>),
      ...extra,
    };
  }
  return extra;
}

function warnIfIgnoringOpenClawCompactionOverrides(params: CompactEmbeddedPiSessionParams): void {
  const activeContextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;
  const ignoredConfig = readIgnoredCompactionOverridePaths(params, activeContextEngine);
  if (ignoredConfig.length === 0) {
    return;
  }
  const warningKey = ignoredConfig.join("\0");
  if (warnedIgnoredCompactionOverrides.has(warningKey)) {
    return;
  }
  warnedIgnoredCompactionOverrides.add(warningKey);
  embeddedAgentLog.warn(
    "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      ignoredConfig,
    },
  );
}

function readIgnoredCompactionOverridePaths(
  params: CompactEmbeddedPiSessionParams,
  activeContextEngine?: CompactEmbeddedPiSessionParams["contextEngine"],
): string[] {
  const ignored = new Set<string>();
  const configuredContextEngine = readStringPath(params.config, [
    "plugins",
    "slots",
    "contextEngine",
  ]);
  const runtimeContextEnginePlugin =
    typeof params.contextEngineRuntimeContext?.contextEnginePluginId === "string"
      ? params.contextEngineRuntimeContext.contextEnginePluginId.trim()
      : "";
  const activeContextEnginePlugin = resolveContextEngineOwnerPluginId(activeContextEngine);
  for (const entry of readCompactionOverrideEntries(params)) {
    const localProvider =
      typeof entry.record.provider === "string" ? entry.record.provider.trim() : "";
    const inheritedProvider =
      !localProvider && typeof entry.inheritedRecord?.provider === "string"
        ? entry.inheritedRecord.provider.trim()
        : "";
    const provider = localProvider || inheritedProvider;
    const providerPath = localProvider
      ? `${entry.path}.compaction.provider`
      : inheritedProvider && entry.inheritedPath
        ? `${entry.inheritedPath}.compaction.provider`
        : undefined;
    const activeLosslessContextEngine =
      provider.toLowerCase() === "lossless-claw" &&
      (activeContextEnginePlugin === "lossless-claw" ||
        runtimeContextEnginePlugin.toLowerCase() === "lossless-claw" ||
        configuredContextEngine?.toLowerCase() === "lossless-claw");
    if (activeLosslessContextEngine) {
      continue;
    }
    if (typeof entry.record.model === "string" && entry.record.model.trim()) {
      ignored.add(`${entry.path}.compaction.model`);
    }
    if (providerPath) {
      ignored.add(providerPath);
    }
  }
  return [...ignored];
}

function readCompactionOverrideEntries(params: CompactEmbeddedPiSessionParams): Array<{
  path: string;
  record: Record<string, unknown>;
  inheritedRecord?: Record<string, unknown>;
  inheritedPath?: string;
}> {
  const entries: Array<{
    path: string;
    record: Record<string, unknown>;
    inheritedRecord?: Record<string, unknown>;
    inheritedPath?: string;
  }> = [];
  const defaultCompaction = readRecord(readRecord(params.config?.agents)?.defaults)?.compaction;
  const defaultRecord = readRecord(defaultCompaction);
  if (defaultRecord) {
    entries.push({ path: "agents.defaults", record: defaultRecord });
  }
  const agentId = readAgentIdFromSessionKey(params.sessionKey ?? params.sandboxSessionKey);
  if (!agentId) {
    return entries;
  }
  const agents = Array.isArray(params.config?.agents?.list) ? params.config.agents.list : [];
  const activeAgent = agents.find((agent) => {
    const id = typeof agent?.id === "string" ? agent.id.trim().toLowerCase() : "";
    return id === agentId;
  });
  const agentCompaction = readRecord(activeAgent)?.compaction;
  const agentRecord = readRecord(agentCompaction);
  if (agentRecord) {
    entries.push({
      path: `agents.list.${agentId}`,
      record: agentRecord,
      inheritedRecord: defaultRecord,
      inheritedPath: "agents.defaults",
    });
  }
  return entries;
}

function readAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const parts = sessionKey?.trim().toLowerCase().split(":").filter(Boolean) ?? [];
  if (parts.length < 3 || parts[0] !== "agent") {
    return undefined;
  }
  return parts[1]?.trim() || undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStringPath(value: unknown, path: readonly string[]): string | undefined {
  let current = value;
  for (const segment of path) {
    current = readRecord(current)?.[segment];
  }
  return typeof current === "string" && current.trim() ? current.trim() : undefined;
}

async function compactCodexNativeThread(
  params: CompactEmbeddedPiSessionParams,
  options: { pluginConfig?: unknown; clientFactory?: CodexAppServerClientFactory } = {},
): Promise<EmbeddedPiCompactResult | undefined> {
  const nativeExecutionBlock = resolveCodexNativeExecutionBlock({
    config: params.config,
    sessionKey: params.sandboxSessionKey ?? params.sessionKey,
    sessionId: params.sessionId,
    surface: "native compaction",
  });
  if (nativeExecutionBlock) {
    return { ok: false, compacted: false, reason: nativeExecutionBlock };
  }
  const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
  const binding = await readCodexAppServerBinding(params.sessionFile, { config: params.config });
  if (!binding?.threadId) {
    return failedCodexThreadBindingCompactionResult(params, {
      reason: "no codex app-server thread binding",
      recovery: "missing_thread_binding",
    });
  }
  const requestedAuthProfileId = params.authProfileId?.trim() || undefined;
  if (
    requestedAuthProfileId &&
    binding.authProfileId &&
    binding.authProfileId !== requestedAuthProfileId
  ) {
    return { ok: false, compacted: false, reason: "auth profile mismatch for session binding" };
  }

  const clientFactory = options.clientFactory ?? defaultCodexAppServerClientFactory;
  let completion: CodexNativeCompactionCompletion | undefined;
  let attempt = 0;
  for (attempt = 1; attempt <= MAX_CODEX_NATIVE_COMPACTION_ATTEMPTS; attempt += 1) {
    const client = await clientFactory(
      appServer.start,
      requestedAuthProfileId ?? binding.authProfileId,
      params.agentDir,
      params.config,
    );
    const waiter = createCodexNativeCompactionWaiter(client, binding.threadId);
    try {
      await client.request("thread/compact/start", {
        threadId: binding.threadId,
      });
      embeddedAgentLog.info("started codex app-server compaction", {
        sessionId: params.sessionId,
        threadId: binding.threadId,
        attempt,
      });
      waiter.startTimeout();
      completion = await waiter.promise;
      break;
    } catch (error) {
      waiter.cancel();
      if (isCodexThreadNotFoundError(error)) {
        await clearCodexAppServerBinding(params.sessionFile, { config: params.config });
        return failedCodexThreadBindingCompactionResult(params, {
          threadId: binding.threadId,
          reason: formatCompactionError(error),
          recovery: "stale_thread_binding",
        });
      }
      if (
        isCodexNativeCompactionTimeoutError(error, binding.threadId) &&
        attempt < MAX_CODEX_NATIVE_COMPACTION_ATTEMPTS
      ) {
        restartCodexAppServerAfterNativeCompactionTimeout(
          client,
          params,
          binding.threadId,
          attempt,
        );
        continue;
      }
      if (isCodexNativeCompactionTimeoutError(error, binding.threadId)) {
        restartCodexAppServerAfterNativeCompactionTimeout(
          client,
          params,
          binding.threadId,
          attempt,
        );
      }
      return {
        ok: false,
        compacted: false,
        reason: formatCompactionError(error),
      };
    }
  }
  if (!completion) {
    return {
      ok: false,
      compacted: false,
      reason: `codex app-server compaction did not complete for ${binding.threadId}`,
    };
  }
  embeddedAgentLog.info("completed codex app-server compaction", {
    sessionId: params.sessionId,
    threadId: binding.threadId,
    signal: completion.signal,
    turnId: completion.turnId,
    itemId: completion.itemId,
    tokensAfter: completion.tokensAfter,
  });
  const resultDetails: JsonObject = {
    backend: "codex-app-server",
    threadId: binding.threadId,
    signal: completion.signal,
  };
  if (completion.turnId) {
    resultDetails.turnId = completion.turnId;
  }
  if (completion.itemId) {
    resultDetails.itemId = completion.itemId;
  }
  if (completion.tokensAfter !== undefined) {
    resultDetails.tokenUsageSource = "thread/tokenUsage/updated";
  }
  if (attempt > 1) {
    resultDetails.compactionAttempts = attempt;
    resultDetails.recoveredAfterAppServerRestart = true;
  }
  return {
    ok: true,
    compacted: true,
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: params.currentTokenCount ?? 0,
      ...(completion.tokensAfter !== undefined ? { tokensAfter: completion.tokensAfter } : {}),
      details: resultDetails,
    },
  };
}

function failedCodexThreadBindingCompactionResult(
  params: CompactEmbeddedPiSessionParams,
  recovery: {
    reason: string;
    recovery: "missing_thread_binding" | "stale_thread_binding";
    threadId?: string;
  },
): EmbeddedPiCompactResult {
  embeddedAgentLog.warn("codex app-server compaction could not use thread binding", {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    threadId: recovery.threadId,
    reason: recovery.reason,
    recovery: recovery.recovery,
  });
  return {
    ok: false,
    compacted: false,
    reason: recovery.reason,
    failure: {
      reason: recovery.recovery,
      rawError: recovery.reason,
    },
  };
}

function isCodexThreadNotFoundError(error: unknown): boolean {
  return formatCompactionError(error).toLowerCase().includes("thread not found");
}

function isCodexNativeCompactionTimeoutError(error: unknown, threadId: string): boolean {
  return error instanceof CodexNativeCompactionTimeoutError && error.threadId === threadId;
}

function restartCodexAppServerAfterNativeCompactionTimeout(
  client: CodexAppServerClient,
  params: CompactEmbeddedPiSessionParams,
  threadId: string,
  attempt: number,
): void {
  embeddedAgentLog.warn("codex app-server compaction timed out; restarting app-server", {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    threadId,
    attempt,
    maxAttempts: MAX_CODEX_NATIVE_COMPACTION_ATTEMPTS,
  });
  client.close();
}

function createCodexNativeCompactionWaiter(
  client: CodexAppServerClient,
  threadId: string,
): CodexNativeCompactionWaiter {
  let settled = false;
  let removeHandler: () => void = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let tokenUsageGraceTimeout: ReturnType<typeof setTimeout> | undefined;
  let failWaiter: (error: Error) => void = () => {};

  const promise = new Promise<CodexNativeCompactionCompletion>((resolve, reject) => {
    const cleanup = (): void => {
      removeHandler();
      if (timeout) {
        clearTimeout(timeout);
      }
      if (tokenUsageGraceTimeout) {
        clearTimeout(tokenUsageGraceTimeout);
      }
    };
    const complete = (completion: CodexNativeCompactionCompletion): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(completion);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    let latestTokensAfter: number | undefined;
    const completionWithLatestTokenUsage = (
      completion: CodexNativeCompactionCompletion,
    ): CodexNativeCompactionCompletion =>
      latestTokensAfter === undefined
        ? completion
        : { ...completion, tokensAfter: latestTokensAfter };
    const completeAfterTokenUsageGrace = (completion: CodexNativeCompactionCompletion): void => {
      if (settled || tokenUsageGraceTimeout) {
        return;
      }
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      tokenUsageGraceTimeout = setTimeout(
        () => complete(completionWithLatestTokenUsage(observedCompletion ?? completion)),
        CODEX_COMPACTION_TOKEN_USAGE_GRACE_MS,
      );
      tokenUsageGraceTimeout.unref?.();
    };
    failWaiter = fail;
    let observedCompletion: CodexNativeCompactionCompletion | undefined;
    const handler: CodexServerNotificationHandler = (notification) => {
      const tokensAfter = readNativeCompactionTokenUsage(notification, threadId);
      if (tokensAfter !== undefined) {
        latestTokensAfter = tokensAfter;
        if (observedCompletion) {
          complete(completionWithLatestTokenUsage(observedCompletion));
          return;
        }
      }
      const completion = readNativeCompactionCompletion(notification, threadId);
      if (completion) {
        observedCompletion = completionWithLatestTokenUsage({
          ...observedCompletion,
          ...completion,
        });
        if (latestTokensAfter !== undefined) {
          complete(observedCompletion);
          return;
        }
        completeAfterTokenUsageGrace(observedCompletion);
      }
    };
    removeHandler = client.addNotificationHandler(handler);
  });

  return {
    promise,
    startTimeout(): void {
      if (settled || timeout) {
        return;
      }
      timeout = setTimeout(() => {
        failWaiter(new CodexNativeCompactionTimeoutError(threadId));
      }, resolveCompactionWaitTimeoutMs());
      timeout.unref?.();
    },
    cancel(): void {
      if (settled) {
        return;
      }
      settled = true;
      removeHandler();
      if (timeout) {
        clearTimeout(timeout);
      }
    },
  };
}

function readNativeCompactionTokenUsage(
  notification: CodexServerNotification,
  threadId: string,
): number | undefined {
  const params = notification.params;
  if (!isJsonObject(params) || readString(params, "threadId", "thread_id") !== threadId) {
    return undefined;
  }
  if (notification.method !== "thread/tokenUsage/updated") {
    return undefined;
  }
  const tokenUsage = isJsonObject(params.tokenUsage) ? params.tokenUsage : undefined;
  const currentUsage = readCodexCurrentTokenUsage(tokenUsage) ?? readCodexCurrentTokenUsage(params);
  return readCodexTotalTokens(currentUsage);
}

function readCodexCurrentTokenUsage(value: JsonObject | undefined): JsonObject | undefined {
  if (!value) {
    return undefined;
  }
  for (const key of [
    "last",
    "current",
    "lastCall",
    "lastCallUsage",
    "lastTokenUsage",
    "last_token_usage",
  ]) {
    const usage = value[key];
    if (isJsonObject(usage)) {
      return usage;
    }
  }
  return undefined;
}

function readCodexTotalTokens(value: JsonObject | undefined): number | undefined {
  const totalTokens = value?.total_tokens ?? value?.totalTokens ?? value?.total;
  return typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0
    ? Math.floor(totalTokens)
    : undefined;
}

function readNativeCompactionCompletion(
  notification: CodexServerNotification,
  threadId: string,
): CodexNativeCompactionCompletion | undefined {
  const params = notification.params;
  if (!isJsonObject(params) || readString(params, "threadId", "thread_id") !== threadId) {
    return undefined;
  }
  if (notification.method === "thread/compacted") {
    return {
      signal: "thread/compacted",
      turnId: readString(params, "turnId", "turn_id"),
    };
  }
  if (notification.method !== "item/completed") {
    return undefined;
  }
  const item = isJsonObject(params.item) ? params.item : undefined;
  if (readString(item, "type") !== "contextCompaction") {
    return undefined;
  }
  return {
    signal: "item/completed",
    turnId: readString(params, "turnId", "turn_id"),
    itemId: readString(item, "id") ?? readString(params, "itemId", "item_id", "id"),
  };
}

function resolveCompactionWaitTimeoutMs(): number {
  const raw = process.env.OPENCLAW_CODEX_COMPACTION_WAIT_TIMEOUT_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_CODEX_COMPACTION_WAIT_TIMEOUT_MS;
}

function readString(params: JsonObject | undefined, ...keys: string[]): string | undefined {
  if (!params) {
    return undefined;
  }
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function formatCompactionError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
