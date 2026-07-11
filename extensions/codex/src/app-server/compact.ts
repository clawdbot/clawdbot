/**
 * Native Codex app-server compaction bridge for bound OpenClaw sessions.
 */
import {
  embeddedAgentLog,
  resolveCompactionTimeoutMs,
  type CompactEmbeddedAgentSessionParams,
  type EmbeddedAgentCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import { readCodexNotificationItem } from "./attempt-notifications.js";
import { resolveCodexBindingAppServerConnection } from "./binding-connection.js";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./client.js";
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

const warnedIgnoredCompactionOverrides = new Set<string>();
const codexNativeCompactionQueues = new Map<string, Promise<void>>();
const CODEX_NATIVE_COMPACTION_INTERRUPT_GRACE_MS = 30_000;
const CODEX_NO_ACTIVE_TURN_ERROR_CODE = -32_600;
const CODEX_NO_ACTIVE_TURN_ERROR_MESSAGE = "no active turn to interrupt";
type CodexAppServerCompactOptions = {
  bindingStore: CodexAppServerBindingStore;
  pluginConfig?: unknown;
  clientFactory?: CodexAppServerClientFactory;
  allowNonManualNativeRequest?: boolean;
  nativeCompletionTimeoutMs?: number;
  nativeInterruptGraceMs?: number;
};

type CodexNativeCompactionCompletion = { completed: true } | { completed: false; reason: string };

function isAlreadyTerminalInterruptError(error: unknown): error is CodexAppServerRpcError {
  return (
    error instanceof CodexAppServerRpcError &&
    error.code === CODEX_NO_ACTIVE_TURN_ERROR_CODE &&
    error.message === CODEX_NO_ACTIVE_TURN_ERROR_MESSAGE
  );
}

function watchCodexNativeCompactionCompletion(params: {
  client: CodexAppServerClient;
  threadId: string;
  signal?: AbortSignal;
  timeoutMs: number;
  interruptGraceMs: number;
  retireUnconfirmed: () => Promise<void>;
}): {
  completion: Promise<CodexNativeCompactionCompletion>;
  beginRequest: () => void;
  confirmRequestRejected: () => void;
  retireUnconfirmedRequest: (reason: string) => Promise<CodexNativeCompactionCompletion>;
  cancel: () => void;
} {
  let settled = false;
  let requestStarted = false;
  let abortRequested = false;
  let interruptRequested = false;
  let retirementStarted = false;
  let compactionTurnId: string | undefined;
  let compactionItemId: string | undefined;
  let compactionItemCompleted = false;
  let resolveCompletion = (_result: CodexNativeCompactionCompletion) => {};
  const completion = new Promise<CodexNativeCompactionCompletion>((resolve) => {
    resolveCompletion = resolve;
  });
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
  const retireUnconfirmed = (reason: string) => {
    if (settled || retirementStarted) {
      return;
    }
    retirementStarted = true;
    void params
      .retireUnconfirmed()
      .then(() => finish({ completed: false, reason }))
      .catch((error: unknown) => {
        embeddedAgentLog.error("failed to retire unconfirmed codex app-server compaction", {
          threadId: params.threadId,
          turnId: compactionTurnId,
          reason: formatCompactionError(error),
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
      .then(() => {
        // Codex answers turn/interrupt only after terminal abort handling, so
        // the RPC response is sufficient when its notification was dropped.
        finish({
          completed: false,
          reason: "codex app-server confirmed native compaction interruption",
        });
      })
      .catch((error: unknown) => {
        // Codex holds normal interrupt RPCs until TurnAborted. This exact
        // InvalidRequest instead proves the target turn was already terminal.
        if (isAlreadyTerminalInterruptError(error)) {
          finish(
            compactionItemCompleted
              ? { completed: true }
              : {
                  completed: false,
                  reason:
                    "codex app-server compaction reached terminal state without a completed compaction item",
                },
          );
          return;
        }
        embeddedAgentLog.warn("codex app-server compaction interrupt request failed", {
          threadId: params.threadId,
          turnId: compactionTurnId,
          reason: formatCompactionError(error),
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
      finish({
        completed: false,
        reason: `codex app-server compaction turn ended with status ${status ?? "unknown"}`,
      });
      return;
    }
    if (!compactionItemId) {
      finish({
        completed: false,
        reason: "codex app-server compaction turn completed without a compaction item",
      });
      return;
    }
    if (!compactionItemCompleted) {
      finish({
        completed: false,
        reason: "codex app-server compaction turn completed before its compaction item",
      });
      return;
    }
    finish({ completed: true });
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
    confirmRequestRejected: () =>
      finish({ completed: false, reason: "codex app-server rejected the compaction request" }),
    retireUnconfirmedRequest: async (reason) => {
      retireUnconfirmed(reason);
      return await completion;
    },
    cancel: () => {
      if (!requestStarted) {
        finish({ completed: false, reason: "compaction request did not start" });
      }
    },
  };
}

async function runExclusiveCodexNativeCompaction<T>(
  threadId: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = codexNativeCompactionQueues.get(threadId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.then(
    () => current,
    () => current,
  );
  codexNativeCompactionQueues.set(threadId, queued);
  try {
    await waitForCodexNativeCompactionQueue(previous, signal);
    signal?.throwIfAborted();
    return await run();
  } finally {
    releaseCurrent();
    // A canceled waiter must remain in the chain until its predecessor settles;
    // otherwise a later request can skip the still-active compaction.
    void queued.then(() => {
      if (codexNativeCompactionQueues.get(threadId) === queued) {
        codexNativeCompactionQueues.delete(threadId);
      }
    });
  }
}

async function waitForCodexNativeCompactionQueue(
  previous: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await previous.catch(() => undefined);
    return;
  }
  signal.throwIfAborted();
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("compaction aborted"));
    };
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([previous.catch(() => undefined), aborted]);
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

function readIgnoredCompactionOverridePaths(params: CompactEmbeddedAgentSessionParams): string[] {
  const ignored = new Set<string>();
  for (const entry of readCompactionOverrideEntries(params)) {
    const localProvider =
      typeof entry.record.provider === "string" ? entry.record.provider.trim() : "";
    const inheritedProvider =
      !localProvider && typeof entry.inheritedRecord?.provider === "string"
        ? entry.inheritedRecord.provider.trim()
        : "";
    const providerPath = localProvider
      ? `${entry.path}.compaction.provider`
      : inheritedProvider && entry.inheritedPath
        ? `${entry.inheritedPath}.compaction.provider`
        : undefined;
    if (typeof entry.record.model === "string" && entry.record.model.trim()) {
      ignored.add(`${entry.path}.compaction.model`);
    }
    if (providerPath) {
      ignored.add(providerPath);
    }
  }
  return [...ignored];
}

function readCompactionOverrideEntries(params: CompactEmbeddedAgentSessionParams): Array<{
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
    return {
      ok: true,
      compacted: false,
      reason: "codex app-server owns automatic compaction",
      result: {
        summary: "",
        firstKeptEntryId: "",
        tokensBefore: params.currentTokenCount ?? 0,
        details: {
          backend: "codex-app-server",
          skipped: true,
          reason: "non_manual_trigger",
          trigger: params.trigger ?? "unknown",
        },
      },
    };
  }
  const nativeExecutionBlock = resolveCodexNativeExecutionBlock({
    config: params.config,
    sessionKey: params.sandboxSessionKey ?? params.sessionKey,
    sessionId: params.sessionId,
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
      reason: formatCompactionError(error),
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
  try {
    return await runExclusiveCodexNativeCompaction(
      binding.threadId,
      params.abortSignal,
      async () => {
        const client = await clientFactory({
          startOptions: appServer.start,
          authProfileId: connection.clientAuthProfileId,
          agentDir: params.agentDir,
          config: params.config,
        });
        const completionWatch = watchCodexNativeCompactionCompletion({
          client,
          threadId: binding.threadId,
          signal: params.abortSignal,
          timeoutMs: options.nativeCompletionTimeoutMs ?? resolveCompactionTimeoutMs(params.config),
          interruptGraceMs:
            options.nativeInterruptGraceMs ?? CODEX_NATIVE_COMPACTION_INTERRUPT_GRACE_MS,
          retireUnconfirmed: async () => {
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
        const beginNativeCompactionRequest = async (timeoutMs?: number) => {
          completionWatch.beginRequest();
          const requestParams = { threadId: binding.threadId };
          if (timeoutMs === undefined) {
            await client.request("thread/compact/start", requestParams);
          } else {
            await client.request("thread/compact/start", requestParams, { timeoutMs });
          }
        };
        const settleNativeCompactionRequestError = async (error: unknown) => {
          if (error instanceof CodexAppServerRpcError) {
            completionWatch.confirmRequestRejected();
          } else {
            // Transport errors after the write leave the server-side start
            // ambiguous. Retire or detach the thread before releasing its fence.
            await completionWatch.retireUnconfirmedRequest(
              `codex app-server compaction start was unconfirmed: ${formatCompactionError(error)}`,
            );
          }
        };
        try {
          if (options.allowNonManualNativeRequest) {
            const guardedResult = await options.bindingStore.withLease(
              bindingIdentity,
              async () => {
                const currentBinding = await options.bindingStore.read(bindingIdentity);
                if (params.abortSignal?.aborted) {
                  return {
                    started: false as const,
                    result: skippedCodexNativeCompactionResult(params, {
                      reason: "codex app-server compaction aborted before native compaction",
                      code: "aborted_before_native_compaction",
                      expectedThreadId: binding.threadId,
                      currentThreadId: currentBinding?.threadId,
                    }),
                  };
                }
                if (!currentBinding || !isSameNativeCompactionBinding(currentBinding, binding)) {
                  embeddedAgentLog.warn(
                    "skipping codex app-server compaction because the thread binding changed",
                    {
                      sessionId: params.sessionId,
                      sessionKey: params.sessionKey,
                      expectedThreadId: binding.threadId,
                      currentThreadId: currentBinding?.threadId,
                    },
                  );
                  return {
                    started: false as const,
                    result: skippedCodexNativeCompactionResult(params, {
                      reason: "codex app-server binding changed before native compaction",
                      code: "binding_changed_before_native_compaction",
                      expectedThreadId: binding.threadId,
                      currentThreadId: currentBinding?.threadId,
                    }),
                  };
                }
                binding = currentBinding;
                await clearContextEngineProjectionBeforeNativeCompaction({
                  sessionId: params.sessionId,
                  bindingStore: options.bindingStore,
                  identity: bindingIdentity,
                  binding,
                });
                try {
                  await beginNativeCompactionRequest(
                    Math.min(
                      appServer.requestTimeoutMs,
                      CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS,
                    ),
                  );
                  return { started: true as const, accepted: true as const };
                } catch (error) {
                  await options.bindingStore.mutate(bindingIdentity, {
                    kind: "set",
                    binding,
                  });
                  // Retire outside the binding lock: remote detach acquires this
                  // same lock and would otherwise deadlock the failure path.
                  return { started: true as const, accepted: false as const, error };
                }
              },
            );
            if (!guardedResult.started) {
              return guardedResult.result;
            }
            if (!guardedResult.accepted) {
              await settleNativeCompactionRequestError(guardedResult.error);
              throw guardedResult.error;
            }
          } else {
            params.abortSignal?.throwIfAborted();
            try {
              await beginNativeCompactionRequest();
            } catch (error) {
              await settleNativeCompactionRequestError(error);
              throw error;
            }
          }
          embeddedAgentLog.info("started codex app-server compaction", {
            sessionId: params.sessionId,
            threadId: binding.threadId,
          });
          const completion = await completionWatch.completion;
          if (!completion.completed) {
            throw new Error(completion.reason);
          }
          embeddedAgentLog.info("completed codex app-server compaction", {
            sessionId: params.sessionId,
            threadId: binding.threadId,
          });
        } catch (error) {
          if (isCodexThreadNotFoundError(error)) {
            return failedCodexThreadBindingCompactionResult(params, {
              threadId: binding.threadId,
              reason: formatCompactionError(error),
              recovery: "stale_thread_binding",
            });
          }
          embeddedAgentLog.warn("codex app-server compaction failed", {
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            threadId: binding.threadId,
            reason: formatCompactionError(error),
          });
          return {
            ok: false,
            compacted: false,
            reason: formatCompactionError(error),
          };
        } finally {
          completionWatch.cancel();
          if (shouldReleaseDefaultLease) {
            releaseLeasedSharedCodexAppServerClient(client);
          }
        }
        const resultDetails: JsonObject = {
          backend: "codex-app-server",
          threadId: binding.threadId,
          signal: "thread/compact/start",
          pending: false,
          completed: true,
          ...(options.allowNonManualNativeRequest
            ? {
                request: "after_context_engine",
                trigger: params.trigger ?? "unknown",
              }
            : {}),
        };
        return {
          ok: true,
          compacted: true,
          result: {
            summary: "",
            firstKeptEntryId: "",
            tokensBefore: params.currentTokenCount ?? 0,
            details: resultDetails,
          },
        };
      },
    );
  } catch (error) {
    if (params.abortSignal?.aborted) {
      if (options.allowNonManualNativeRequest) {
        return skippedCodexNativeCompactionResult(params, {
          reason: "codex app-server compaction aborted before native compaction",
          code: "aborted_before_native_compaction",
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

function skippedCodexNativeCompactionResult(
  params: CompactEmbeddedAgentSessionParams,
  skipped: {
    reason: string;
    code: string;
    expectedThreadId?: string;
    currentThreadId?: string;
  },
): EmbeddedAgentCompactResult {
  return {
    ok: true,
    compacted: false,
    reason: skipped.reason,
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: params.currentTokenCount ?? 0,
      details: {
        backend: "codex-app-server",
        skipped: true,
        reason: skipped.code,
        request: "after_context_engine",
        trigger: params.trigger ?? "unknown",
        ...(skipped.expectedThreadId ? { expectedThreadId: skipped.expectedThreadId } : {}),
        ...(skipped.currentThreadId ? { currentThreadId: skipped.currentThreadId } : {}),
      },
    },
  };
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
    current.threadId === expected.threadId &&
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
  return formatCompactionError(error).toLowerCase().includes("thread not found");
}

function formatCompactionError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
