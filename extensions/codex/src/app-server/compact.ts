import { AsyncLocalStorage } from "node:async_hooks";
import {
  embeddedAgentLog,
  resolveCompactionTimeoutMs,
  type CompactEmbeddedAgentSessionParams,
  type EmbeddedAgentCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isIncognitoSessionKey } from "../incognito-session.js";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  isCodexAlreadyTerminalInterruptError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { readCodexNotificationItem } from "./attempt-notifications.js";
import { resolveCodexBindingAppServerConnection } from "./binding-connection.js";
import {
  consumeCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
  type CodexAppServerLiveThreadOwnership,
} from "./client-runtime.js";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./client.js";
import { persistCodexContextCompactionActivity } from "./context-compaction-activity.js";
import { readCodexThreadContextSnapshot } from "./event-projector-usage.js";
import {
  readCodexNotificationThreadId,
  readCodexNotificationTurnId,
} from "./notification-correlation.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { resolveCodexNativeExecutionBlock } from "./sandbox-guard.js";
import {
  CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS,
  sessionBindingIdentity,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import { isSameCodexAppServerThreadOwner } from "./thread-ownership.js";
import { assertCodexSupervisionThreadLineage } from "./thread-policy.js";
import { resumeCodexAppServerThread } from "./thread-resume.js";

// ttlMs: 0 retains keys until the 4,096-entry LRU cap evicts them, after which a
// previously suppressed warning can intentionally emit again.
const warnedIgnoredCompactionOverrides = createDedupeCache({ ttlMs: 0, maxSize: 4096 });
const codexNativeCompactionQueue = new KeyedAsyncQueue();
const CODEX_NATIVE_COMPACTION_INTERRUPT_GRACE_MS = 30_000;
type CodexAppServerCompactOptions = {
  bindingStore: CodexAppServerBindingStore;
  pluginConfig?: unknown;
  clientFactory?: CodexAppServerClientFactory;
  allowNonManualNativeRequest?: boolean;
  nativeCompactionRequest?: "required_preflight" | "after_context_engine";
  nativeCompletionTimeoutMs?: number;
  nativeInterruptGraceMs?: number;
};

type CodexNativeCompactionCompletion =
  | { completed: true; turnId?: string; itemId?: string; tokensAfter?: number }
  | { completed: false; reason: string };

function watchCodexNativeCompactionCompletion(params: {
  client: CodexAppServerClient;
  threadId: string;
  signal?: AbortSignal;
  timeoutMs: number;
  interruptGraceMs: number;
  retireUnconfirmed: () => Promise<void>;
}) {
  const runOutsideBindingLease = AsyncLocalStorage.snapshot();
  let settled = false;
  let requestStarted = false;
  let abortRequested = false;
  let interruptRequested = false;
  let retirementStarted = false;
  let compactionTurnId: string | undefined;
  let compactionItemId: string | undefined;
  let compactionItemCompleted = false;
  let tokensAfter: number | undefined;
  const { promise: completion, resolve: resolveCompletion } =
    createDeferred<CodexNativeCompactionCompletion>();
  let removeNotificationHandler = () => {};
  let removeCloseHandler = () => {};
  let removeAbortHandler = () => {};
  let completionTimeout: ReturnType<typeof setTimeout> | undefined;
  let interruptGraceTimeout: ReturnType<typeof setTimeout> | undefined;
  const finish = (result: CodexNativeCompactionCompletion) => {
    if (settled) {
      return;
    }
    settled = true;
    removeNotificationHandler();
    removeCloseHandler();
    removeAbortHandler();
    clearTimeout(completionTimeout);
    clearTimeout(interruptGraceTimeout);
    resolveCompletion(result);
  };
  const complete = () =>
    finish({
      completed: true,
      ...(compactionTurnId ? { turnId: compactionTurnId } : {}),
      ...(compactionItemId ? { itemId: compactionItemId } : {}),
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
    });
  const fail = (reason: string) => finish({ completed: false, reason });
  const retireUnconfirmed = (reason: string) => {
    if (settled || retirementStarted) {
      return;
    }
    retirementStarted = true;
    // Timers started under the short-lived binding lease inherit its async
    // owner. Remote retirement must not reuse that already-released token.
    void runOutsideBindingLease(() => params.retireUnconfirmed())
      .then(() => fail(reason))
      .catch((error: unknown) => {
        embeddedAgentLog.error("failed to retire unconfirmed codex app-server compaction", {
          threadId: params.threadId,
          turnId: compactionTurnId,
          reason: coerceErrorMessage(error),
        });
        // Keep the lifecycle fence held when neither terminal state nor thread
        // retirement can be proven. Releasing would permit same-thread overlap.
      });
  };
  const requestInterrupt = () => {
    if (settled || !requestStarted || !abortRequested || !compactionTurnId || interruptRequested) {
      return;
    }
    interruptRequested = true;
    void params.client
      .request(
        "turn/interrupt",
        {
          threadId: params.threadId,
          turnId: compactionTurnId,
        },
        { timeoutMs: Math.max(1, params.interruptGraceMs) },
      )
      .catch((error: unknown) => {
        // This exact InvalidRequest proves the target turn was already terminal.
        if (isCodexAlreadyTerminalInterruptError(error)) {
          if (compactionItemCompleted) {
            complete();
            return;
          }
          fail(
            "codex app-server compaction reached terminal state without a completed compaction item",
          );
          return;
        }
        embeddedAgentLog.warn("codex app-server compaction interrupt request failed", {
          threadId: params.threadId,
          turnId: compactionTurnId,
          reason: coerceErrorMessage(error),
        });
      });
  };
  const beginInterruptGrace = () => {
    if (settled || !requestStarted || interruptGraceTimeout) {
      return;
    }
    requestInterrupt();
    interruptGraceTimeout = setTimeout(
      () => {
        embeddedAgentLog.warn(
          "codex app-server compaction did not reach terminal state after interruption",
          {
            threadId: params.threadId,
            turnId: compactionTurnId,
            interruptGraceMs: params.interruptGraceMs,
          },
        );
        retireUnconfirmed(
          "codex app-server compaction did not reach terminal state after interruption",
        );
      },
      Math.max(1, params.interruptGraceMs),
    );
    interruptGraceTimeout.unref?.();
  };
  const beginCompletionTimeout = () => {
    completionTimeout = setTimeout(
      () => {
        abortRequested = true;
        beginInterruptGrace();
        // Keep the shared client lease and per-thread fence through terminal state or
        // forced process retirement; releasing earlier could overlap the same transcript.
        embeddedAgentLog.warn("codex app-server compaction exceeded its completion budget", {
          threadId: params.threadId,
          timeoutMs: params.timeoutMs,
          interruptRequested,
        });
      },
      Math.max(1, params.timeoutMs),
    );
    completionTimeout.unref?.();
  };
  removeNotificationHandler = params.client.addNotificationHandler((notification) => {
    if (!requestStarted) {
      return;
    }
    if (!isJsonObject(notification.params)) {
      return;
    }
    if (readCodexNotificationThreadId(notification.params) !== params.threadId) {
      return;
    }
    const notificationTurnId = readCodexNotificationTurnId(notification.params);
    if (notification.method === "turn/started") {
      compactionTurnId = notificationTurnId;
      requestInterrupt();
      return;
    }
    if (compactionTurnId && notificationTurnId !== compactionTurnId) {
      return;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      tokensAfter =
        readCodexThreadContextSnapshot(notification.params).activeContextTokens ?? tokensAfter;
      return;
    }
    const item = readCodexNotificationItem(notification.params);
    if (item?.type === "contextCompaction") {
      if (notification.method === "item/started") {
        compactionTurnId = compactionTurnId ?? notificationTurnId;
        compactionItemId = item.id;
        requestInterrupt();
        return;
      }
      if (notification.method === "item/completed" && compactionItemId === item.id) {
        compactionItemCompleted = true;
        return;
      }
    }
    if (
      notification.method !== "turn/completed" ||
      !compactionTurnId ||
      notificationTurnId !== compactionTurnId
    ) {
      return;
    }
    const turn = isJsonObject(notification.params.turn) ? notification.params.turn : undefined;
    const status = typeof turn?.status === "string" ? turn.status : undefined;
    if (status !== "completed") {
      fail(`codex app-server compaction turn ended with status ${status ?? "unknown"}`);
      return;
    }
    const incompleteReason = !compactionItemId
      ? "codex app-server compaction turn completed without a compaction item"
      : !compactionItemCompleted
        ? "codex app-server compaction turn completed before its compaction item"
        : undefined;
    if (incompleteReason) {
      fail(incompleteReason);
      return;
    }
    complete();
  });
  removeCloseHandler = params.client.addCloseHandler(() => {
    retireUnconfirmed("codex app-server closed before native compaction completed");
  });
  if (params.signal) {
    const onAbort = () => {
      abortRequested = true;
      beginInterruptGrace();
    };
    params.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortHandler = () => params.signal?.removeEventListener("abort", onAbort);
    if (params.signal.aborted) {
      onAbort();
    }
  }
  return {
    completion,
    beginRequest: () => {
      requestStarted = true;
      beginCompletionTimeout();
      if (abortRequested) {
        beginInterruptGrace();
      }
    },
    confirmRequestRejected: () => fail("codex app-server rejected the compaction request"),
    retireUnconfirmedRequest: async (reason: string) => {
      retireUnconfirmed(reason);
      return await completion;
    },
    cancel: () => {
      if (!requestStarted) {
        fail("compaction request did not start");
      }
    },
  };
}

async function runExclusiveCodexNativeCompaction<T>(
  threadId: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  let started = false;
  const queued = codexNativeCompactionQueue.enqueue(threadId, async () => {
    started = true;
    signal?.throwIfAborted();
    return run();
  });
  if (!signal) {
    return queued;
  }
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => {
      if (!started) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("compaction aborted"));
      }
    };
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // The canceled promise settles immediately, but its queued task remains
    // behind its predecessor so later compactions cannot overtake active work.
    return await Promise.race([queued, aborted]);
  } finally {
    removeAbortListener();
  }
}

/**
 * Starts native Codex compaction for a manually requested bound session, or
 * reports why Codex-owned automatic compaction should handle the trigger.
 */
export async function maybeCompactCodexAppServerSession(
  params: CompactEmbeddedAgentSessionParams,
  options: CodexAppServerCompactOptions,
): Promise<EmbeddedAgentCompactResult | undefined> {
  warnIfIgnoringOpenClawCompactionOverrides(params);
  // Codex owns automatic context-pressure compaction for Codex runtime sessions.
  // This entry point starts native Codex compaction for the bound thread and
  // retains the lease until Codex reports the context-compaction item complete.
  return compactCodexNativeThread(params, options);
}

function warnIfIgnoringOpenClawCompactionOverrides(
  params: CompactEmbeddedAgentSessionParams,
): void {
  const ignoredConfig = readIgnoredCompactionOverridePaths(params);
  if (ignoredConfig.length === 0) {
    return;
  }
  const warningKey = ignoredConfig.join("\0");
  if (warnedIgnoredCompactionOverrides.check(warningKey)) {
    return;
  }
  embeddedAgentLog.warn(
    "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      ignoredConfig,
    },
  );
}

function readIgnoredCompactionOverridePaths(params: CompactEmbeddedAgentSessionParams): string[] {
  const ignored = new Set<string>();
  for (const entry of readCompactionOverrideEntries(params)) {
    const localProvider =
      typeof entry.record.provider === "string" ? entry.record.provider.trim() : "";
    if (typeof entry.record.model === "string" && entry.record.model.trim()) {
      ignored.add(`${entry.path}.compaction.model`);
    }
    if (typeof entry.record.thinkingLevel === "string" && entry.record.thinkingLevel.trim()) {
      ignored.add(`${entry.path}.compaction.thinkingLevel`);
    }
    if (localProvider) {
      ignored.add(`${entry.path}.compaction.provider`);
    }
  }
  return [...ignored];
}

function readCompactionOverrideEntries(params: CompactEmbeddedAgentSessionParams): Array<{
  path: string;
  record: Record<string, unknown>;
}> {
  const entries: Array<{
    path: string;
    record: Record<string, unknown>;
  }> = [];
  const defaultRecord = asOptionalRecord(params.config?.agents?.defaults?.compaction);
  if (defaultRecord) {
    entries.push({ path: "agents.defaults", record: defaultRecord });
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

async function compactCodexNativeThread(
  params: CompactEmbeddedAgentSessionParams,
  options: CodexAppServerCompactOptions,
): Promise<EmbeddedAgentCompactResult | undefined> {
  if (params.trigger !== "manual" && !options.allowNonManualNativeRequest) {
    embeddedAgentLog.info("skipping codex app-server compaction for non-manual trigger", {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      trigger: params.trigger,
    });
    return codexNativeCompactionResult(params, {
      compacted: false,
      reason: "codex app-server owns automatic compaction",
      details: {
        backend: "codex-app-server",
        skipped: true,
        reason: "non_manual_trigger",
        trigger: params.trigger ?? "unknown",
      },
    });
  }
  const sandbox = (params as typeof params & { sandbox?: SandboxContext | null }).sandbox;
  const nativeExecutionBlock = resolveCodexNativeExecutionBlock({
    config: params.config,
    sessionKey: params.sandboxSessionKey ?? params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.sandboxAgentId ?? params.agentId,
    sandbox,
    surface: "native compaction",
  });
  if (nativeExecutionBlock) {
    return { ok: false, compacted: false, reason: nativeExecutionBlock };
  }
  const bindingIdentity: CodexAppServerBindingIdentity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const initialBinding = await options.bindingStore.read(bindingIdentity);
  if (!initialBinding?.threadId) {
    return failedCodexThreadBindingCompactionResult(params, {
      reason: "no codex app-server thread binding",
      recovery: "missing_thread_binding",
    });
  }
  if (
    params.nativeToolSurface === "host-isolated" ||
    initialBinding.nativeToolPolicyRestricted === true ||
    initialBinding.ringZeroConfigFingerprint !== undefined
  ) {
    // Compact is a separate Codex operation without a turn-scoped environment
    // override, so resuming here would silently restore ambient native tools.
    return codexNativeCompactionResult(params, {
      compacted: false,
      reason: "native compaction is unavailable for a host-isolated Codex session",
      details: {
        backend: "codex-app-server",
        skipped: true,
        reason: "native_tool_policy_restricted",
        expectedThreadId: initialBinding.threadId,
      },
    });
  }
  let binding = initialBinding;
  const requestedAuthProfileId = params.authProfileId?.trim() || undefined;
  let connection: ReturnType<typeof resolveCodexBindingAppServerConnection>;
  try {
    const config = params.config ?? {};
    const agentId =
      params.agentId ??
      readAgentIdFromSessionKey(params.sessionKey) ??
      resolveDefaultAgentId(config);
    connection = resolveCodexBindingAppServerConnection({
      binding,
      authProfileId: requestedAuthProfileId ?? binding.authProfileId,
      pluginConfig: options.pluginConfig,
      config,
      agentDir: resolveAgentDir(config, agentId),
    });
  } catch (error) {
    return {
      ok: false,
      compacted: false,
      reason: coerceErrorMessage(error),
    };
  }
  const { appServer, usesSupervisionConnection } = connection;
  if (
    !usesSupervisionConnection &&
    requestedAuthProfileId &&
    binding.authProfileId &&
    binding.authProfileId !== requestedAuthProfileId
  ) {
    // A session binding belongs to the auth profile that created it; compacting
    // with another profile risks operating on a different Codex account.
    return { ok: false, compacted: false, reason: "auth profile mismatch for session binding" };
  }
  const shouldReleaseDefaultLease = !options.clientFactory;
  const clientFactory = options.clientFactory ?? getLeasedSharedCodexAppServerClient;
  const runtimeAuthPlan = params.runtimeAuthPlan ?? params.runtimePlan?.auth;
  // A user-home app-server keeps its native Codex account; injecting a prepared key
  // would rewrite the CODEX_HOME auth that Codex CLI and Desktop share.
  const usesPreparedApiKey =
    !usesSupervisionConnection &&
    appServer.start.homeScope !== "user" &&
    runtimeAuthPlan?.modelRoute?.authRequirement === "api-key";
  const preparedApiKey = usesPreparedApiKey ? params.resolvedApiKey?.trim() : undefined;
  if (usesPreparedApiKey && !preparedApiKey) {
    return {
      ok: false,
      compacted: false,
      reason: "Prepared Codex Platform compaction route is missing its resolved API key.",
    };
  }
  try {
    return await runExclusiveCodexNativeCompaction(
      binding.threadId,
      params.abortSignal,
      async () => {
        const client = await clientFactory({
          startOptions: appServer.start,
          ...(preparedApiKey
            ? { preparedAuth: { kind: "api-key" as const, apiKey: preparedApiKey } }
            : { authProfileId: connection.clientAuthProfileId }),
          agentDir: params.agentDir,
          config: params.config,
        });
        let releaseThreadSubscription: (() => Promise<void>) | undefined;
        let retainedThreadOwnership: CodexAppServerLiveThreadOwnership | undefined;
        let compactionSucceeded = false;
        let compactionRequestDefinitelyRejected = false;
        let tokensAfter: number | undefined;
        const releaseCompactionThread = async (threadId: string) => {
          if (
            await unsubscribeCodexThreadBestEffort(client, {
              threadId,
              timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
            })
          ) {
            return;
          }
          await closeCodexStartupClientBestEffort(client);
          throw new CodexAppServerUnsafeSubscriptionError(
            `Codex compaction thread subscription could not be released: ${threadId}`,
          );
        };
        const completionWatch = watchCodexNativeCompactionCompletion({
          client,
          threadId: binding.threadId,
          signal: params.abortSignal,
          timeoutMs: options.nativeCompletionTimeoutMs ?? resolveCompactionTimeoutMs(params.config),
          interruptGraceMs:
            options.nativeInterruptGraceMs ?? CODEX_NATIVE_COMPACTION_INTERRUPT_GRACE_MS,
          retireUnconfirmed: async () => {
            releaseThreadSubscription = undefined;
            const transportStopped = await client.closeAndWait({
              exitTimeoutMs: 5_000,
              forceKillDelayMs: 250,
            });
            if (appServer.start.transport === "stdio") {
              if (transportStopped) {
                return;
              }
              // A local thread remains runnable with its stdio process. Keep
              // the lifecycle fence held unless process exit is observed.
              throw new Error("failed to stop unconfirmed codex app-server process");
            }
            if (usesSupervisionConnection) {
              // A supervised thread is native user-home state, not an
              // OpenClaw-owned remote binding. Keep the lifecycle fence held
              // rather than detach and permit a second writer.
              throw new Error("cannot detach an unconfirmed supervised codex thread");
            }
            // Closing a WebSocket proves only that the connection ended, not
            // that its remote turn stopped. Detach this exact thread before
            // allowing future work to acquire the session lifecycle fence.
            const bindingCleared = await options.bindingStore.mutate(bindingIdentity, {
              kind: "clear",
              threadId: binding.threadId,
            });
            if (bindingCleared) {
              return;
            }
            const currentBinding = await options.bindingStore.read(bindingIdentity);
            if (currentBinding?.threadId !== binding.threadId) {
              return;
            }
            throw new Error("failed to detach unconfirmed codex app-server thread binding");
          },
        });
        const acquireThreadSubscription = async (timeoutMs?: number) => {
          if (!isIncognitoSessionKey(params.sessionKey)) {
            // Remove any idle ownership first: sibling cleanup must not evict
            // this subscription while compaction still awaits terminal events.
            retainedThreadOwnership = await consumeCodexAppServerLiveThread(
              client,
              binding.threadId,
            );
            if (!retainedThreadOwnership) {
              const resumed = await resumeCodexAppServerThread({
                client,
                abandonClient: async () => closeCodexStartupClientBestEffort(client),
                request: { threadId: binding.threadId, excludeTurns: true },
                timeoutMs: timeoutMs ?? appServer.requestTimeoutMs,
                ...(params.abortSignal ? { signal: params.abortSignal } : {}),
              });
              releaseThreadSubscription = async () => releaseCompactionThread(binding.threadId);
              assertCodexSupervisionThreadLineage(binding, resumed.thread);
            } else if (binding.connectionScope === "supervision") {
              releaseThreadSubscription = async () =>
                retainedThreadOwnership?.release(binding.threadId);
              const { thread } = await client.request("thread/read", {
                threadId: binding.threadId,
                includeTurns: false,
              });
              retainedThreadOwnership.assertCurrent();
              assertCodexSupervisionThreadLineage(binding, thread);
            }
            releaseThreadSubscription ??= async () => releaseCompactionThread(binding.threadId);
          }
        };
        try {
          const guardedResult = await options.bindingStore.withLease(bindingIdentity, async () => {
            const currentBinding = await options.bindingStore.read(bindingIdentity);
            if (params.abortSignal?.aborted) {
              if (!options.allowNonManualNativeRequest) {
                params.abortSignal.throwIfAborted();
              }
              return {
                started: false as const,
                result: skippedCodexNativeCompactionResult(params, {
                  reason: "codex app-server compaction aborted before native compaction",
                  code: "aborted_before_native_compaction",
                  request: options.nativeCompactionRequest ?? "after_context_engine",
                  expectedThreadId: binding.threadId,
                  currentThreadId: currentBinding?.threadId,
                }),
              };
            }
            if (!currentBinding || !isSameNativeCompactionBinding(currentBinding, binding)) {
              embeddedAgentLog.warn(
                "codex app-server compaction could not use the thread binding because it changed",
                {
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                  expectedThreadId: binding.threadId,
                  currentThreadId: currentBinding?.threadId,
                },
              );
              // A binding change between the initial read and the native request
              // is a stale-binding race. For required-preflight (and the
              // non-manual CLI path) it must surface as the canonical
              // recoverable failure so the caller falls back to the context
              // engine instead of treating an uncompacted ok:true skip as a
              // completed turn. Only a genuine post-context-engine request may
              // skip, because the context engine has already compacted.
              const isRequiredPreflight = options.nativeCompactionRequest === "required_preflight";
              return {
                started: false as const,
                result:
                  options.allowNonManualNativeRequest && !isRequiredPreflight
                    ? skippedCodexNativeCompactionResult(params, {
                        reason: "codex app-server binding changed before native compaction",
                        code: "binding_changed_before_native_compaction",
                        request: options.nativeCompactionRequest ?? "after_context_engine",
                        expectedThreadId: binding.threadId,
                        currentThreadId: currentBinding?.threadId,
                      })
                    : failedCodexThreadBindingCompactionResult(params, {
                        threadId: currentBinding?.threadId ?? binding.threadId,
                        reason: "codex app-server binding changed before native compaction",
                        recovery: "stale_thread_binding",
                      }),
              };
            }
            binding = currentBinding;
            const guardedRequestTimeoutMs = options.allowNonManualNativeRequest
              ? Math.min(
                  appServer.requestTimeoutMs,
                  CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS,
                )
              : undefined;
            await acquireThreadSubscription(guardedRequestTimeoutMs);
            await clearContextEngineProjectionBeforeNativeCompaction({
              sessionId: params.sessionId,
              bindingStore: options.bindingStore,
              identity: bindingIdentity,
              binding,
            });
            try {
              completionWatch.beginRequest();
              if (guardedRequestTimeoutMs === undefined) {
                await client.request("thread/compact/start", { threadId: binding.threadId });
              } else {
                await client.request(
                  "thread/compact/start",
                  { threadId: binding.threadId },
                  { timeoutMs: guardedRequestTimeoutMs },
                );
              }
              return { started: true as const, accepted: true as const };
            } catch (error) {
              if (error instanceof CodexAppServerRpcError) {
                // A server rejection proves native history was untouched; an
                // ambiguous transport failure must never restore stale context.
                await options.bindingStore.mutate(bindingIdentity, {
                  kind: "set",
                  binding,
                });
                compactionRequestDefinitelyRejected = !isCodexThreadNotFoundError(error);
              }
              // Retirement can acquire this same generation lease.
              return { started: true as const, accepted: false as const, error };
            }
          });
          if (!guardedResult.started) {
            return guardedResult.result;
          }
          if (!guardedResult.accepted) {
            if (guardedResult.error instanceof CodexAppServerRpcError) {
              completionWatch.confirmRequestRejected();
            } else {
              // Transport errors after the write leave the server-side start
              // ambiguous. Retire or detach the thread before releasing its fence.
              await completionWatch.retireUnconfirmedRequest(
                `codex app-server compaction start was unconfirmed: ${coerceErrorMessage(guardedResult.error)}`,
              );
            }
            throw guardedResult.error;
          }
          embeddedAgentLog.info("started codex app-server compaction", {
            sessionId: params.sessionId,
            threadId: binding.threadId,
          });
          const completion = await completionWatch.completion;
          if (!completion.completed) {
            throw new Error(completion.reason);
          }
          tokensAfter = completion.tokensAfter;
          if (completion.turnId && completion.itemId) {
            await persistCodexContextCompactionActivity({
              sessionTarget: params.sessionTarget,
              config: params.config,
              cwd: params.workspaceDir,
              runId: params.runId,
              threadId: binding.threadId,
              turnId: completion.turnId,
              itemId: completion.itemId,
              timestamp: Date.now(),
            });
          }
          embeddedAgentLog.info("completed codex app-server compaction", {
            sessionId: params.sessionId,
            threadId: binding.threadId,
          });
          compactionSucceeded = true;
        } catch (error) {
          if (isCodexThreadNotFoundError(error)) {
            return failedCodexThreadBindingCompactionResult(params, {
              threadId: binding.threadId,
              reason: coerceErrorMessage(error),
              recovery: "stale_thread_binding",
            });
          }
          embeddedAgentLog.warn("codex app-server compaction failed", {
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            threadId: binding.threadId,
            reason: coerceErrorMessage(error),
          });
          return {
            ok: false,
            compacted: false,
            reason: coerceErrorMessage(error),
          };
        } finally {
          completionWatch.cancel();
          try {
            if (
              (compactionSucceeded || compactionRequestDefinitelyRejected) &&
              retainedThreadOwnership
            ) {
              const ownership = retainedThreadOwnership;
              const currentBinding = await options.bindingStore.read(bindingIdentity);
              // Reset uses this same generation lease; without it compaction
              // could return an obsolete subscription after its owner ended.
              const retained =
                isSameCodexAppServerThreadOwner(currentBinding, binding) &&
                (await options.bindingStore.withLease(bindingIdentity, async () => {
                  const leasedBinding = await options.bindingStore.read(bindingIdentity);
                  if (!isSameCodexAppServerThreadOwner(leasedBinding, binding)) {
                    return false;
                  }
                  return await retainCodexAppServerLiveThread(
                    client,
                    binding.threadId,
                    ownership.release,
                    ownership.configFingerprint,
                    ownership.serviceTier,
                  );
                }));
              if (!retained) {
                await releaseThreadSubscription?.();
              }
            } else {
              await releaseThreadSubscription?.();
            }
          } finally {
            if (shouldReleaseDefaultLease) {
              releaseLeasedSharedCodexAppServerClient(client);
            }
          }
        }
        const details: JsonObject = {
          backend: "codex-app-server",
          threadId: binding.threadId,
          signal: "thread/compact/start",
          pending: false,
          completed: true,
          ...(options.allowNonManualNativeRequest
            ? {
                request: options.nativeCompactionRequest ?? "after_context_engine",
                trigger: params.trigger ?? "unknown",
              }
            : {}),
        };
        return codexNativeCompactionResult(params, { compacted: true, tokensAfter, details });
      },
    );
  } catch (error) {
    if (params.abortSignal?.aborted) {
      if (options.allowNonManualNativeRequest) {
        return skippedCodexNativeCompactionResult(params, {
          reason: "codex app-server compaction aborted before native compaction",
          code: "aborted_before_native_compaction",
          request: options.nativeCompactionRequest ?? "after_context_engine",
          expectedThreadId: initialBinding.threadId,
          currentThreadId: binding.threadId,
        });
      }
      return {
        ok: false,
        compacted: false,
        reason: "codex app-server compaction aborted while waiting to start",
      };
    }
    throw error;
  }
}

function codexNativeCompactionResult(
  params: CompactEmbeddedAgentSessionParams,
  outcome: { compacted: boolean; reason?: string; tokensAfter?: number; details: JsonObject },
): EmbeddedAgentCompactResult {
  return {
    ok: true,
    compacted: outcome.compacted,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: params.currentTokenCount ?? 0,
      ...(outcome.tokensAfter !== undefined ? { tokensAfter: outcome.tokensAfter } : {}),
      details: outcome.details,
    },
  };
}

function skippedCodexNativeCompactionResult(
  params: CompactEmbeddedAgentSessionParams,
  skipped: {
    reason: string;
    code: string;
    request?: "required_preflight" | "after_context_engine";
    expectedThreadId?: string;
    currentThreadId?: string;
  },
): EmbeddedAgentCompactResult {
  return codexNativeCompactionResult(params, {
    compacted: false,
    reason: skipped.reason,
    details: {
      backend: "codex-app-server",
      skipped: true,
      reason: skipped.code,
      request: skipped.request ?? "after_context_engine",
      trigger: params.trigger ?? "unknown",
      ...(skipped.expectedThreadId ? { expectedThreadId: skipped.expectedThreadId } : {}),
      ...(skipped.currentThreadId ? { currentThreadId: skipped.currentThreadId } : {}),
    },
  });
}

function failedCodexThreadBindingCompactionResult(
  params: CompactEmbeddedAgentSessionParams,
  recovery: {
    reason: string;
    recovery: "missing_thread_binding" | "stale_thread_binding";
    threadId?: string;
  },
): EmbeddedAgentCompactResult {
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

async function clearContextEngineProjectionBeforeNativeCompaction(params: {
  sessionId: string;
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  binding: CodexAppServerThreadBinding;
}): Promise<void> {
  const contextEngineBinding = params.binding.contextEngine;
  if (!contextEngineBinding?.projection) {
    return;
  }
  // Native Codex compaction mutates the thread history outside the projection
  // guard. Clear only the projection marker so the next turn reprojects context.
  await params.bindingStore.mutate(params.identity, {
    kind: "patch",
    threadId: params.binding.threadId,
    patch: {
      contextEngine: {
        ...contextEngineBinding,
        projection: undefined,
      },
    },
  });
  embeddedAgentLog.info("cleared codex context-engine projection before native compaction", {
    sessionId: params.sessionId,
    threadId: params.binding.threadId,
    previousEpoch: contextEngineBinding.projection.epoch,
    previousFingerprint: contextEngineBinding.projection.fingerprint,
  });
}

function isSameNativeCompactionBinding(
  current: CodexAppServerThreadBinding,
  expected: CodexAppServerThreadBinding,
): boolean {
  return (
    isSameCodexAppServerThreadOwner(current, expected) &&
    current.authProfileId === expected.authProfileId &&
    current.contextEngine?.engineId === expected.contextEngine?.engineId &&
    current.contextEngine?.policyFingerprint === expected.contextEngine?.policyFingerprint &&
    current.contextEngine?.projection?.mode === expected.contextEngine?.projection?.mode &&
    current.contextEngine?.projection?.epoch === expected.contextEngine?.projection?.epoch &&
    current.contextEngine?.projection?.fingerprint ===
      expected.contextEngine?.projection?.fingerprint
  );
}

function isCodexThreadNotFoundError(error: unknown): boolean {
  // codex-rs exposes no dedicated error code for a missing compaction thread:
  // thread/compact/start returns generic INVALID_REQUEST (-32600), and the
  // app-server's own contract/test asserts the "thread not found" MESSAGE as
  // the discriminator (thread_processor.rs load_thread → invalid_request;
  // compaction.rs asserts message.contains("thread not found")). So the message
  // is the authoritative positive signal here, not the generic code. This is a
  // self-heal recovery gate, not user-facing classification.
  return coerceErrorMessage(error).toLowerCase().includes("thread not found");
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
