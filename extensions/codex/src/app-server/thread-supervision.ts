import {
  embeddedAgentLog,
  formatErrorMessage,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  CodexAppServerUnsafeSubscriptionError,
  isCodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import {
  assertCodexThreadForkResponse,
  assertCodexThreadStartResponse,
} from "./protocol-validators.js";
import type {
  CodexDynamicToolSpec,
  CodexThread,
  CodexThreadForkParams,
  CodexTurnEnvironmentParams,
  JsonObject,
} from "./protocol.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
  CodexAppServerPendingSupervisionBranch,
  CodexAppServerThreadBinding,
} from "./session-binding.js";
import {
  CodexThreadBindingConflictAfterCleanupError,
  CodexThreadBindingConflictError,
  CodexThreadStartRequestError,
} from "./thread-lifecycle-errors.js";
import type { CodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import type { CodexAppServerThreadLifecycleBinding } from "./thread-lifecycle-types.js";
import { buildDeveloperInstructions } from "./thread-prompt.js";
import {
  buildCodexRuntimeThreadConfigForRun,
  buildThreadStartParams,
  codexThreadSandboxOrPermissions,
  resolveCodexThreadApprovalsReviewer,
} from "./thread-requests.js";
import { projectBoundedCodexThreadHistory } from "./transcript-mirror.js";
import type { CodexNativeWebSearchSupport } from "./web-search.js";

type PendingSupervisionMaterializationParams = {
  client: CodexAppServerClient;
  abandonClient: () => Promise<void>;
  bindingStore: CodexAppServerBindingStore;
  bindingIdentity: CodexAppServerBindingIdentity;
  binding: CodexAppServerThreadBinding & {
    pendingSupervisionBranch: CodexAppServerPendingSupervisionBranch;
  };
  attempt: EmbeddedRunAttemptParams;
  cwd: string;
  dynamicTools: CodexDynamicToolSpec[];
  appServer: CodexAppServerRuntimeOptions;
  developerInstructions?: string;
  config?: JsonObject;
  nativeCodeModeEnabled?: boolean;
  nativeProviderWebSearchSupport?: CodexNativeWebSearchSupport;
  nativeCodeModeOnlyEnabled?: boolean;
  webSearchAllowed?: boolean;
  environmentSelection?: CodexTurnEnvironmentParams[];
  signal?: AbortSignal;
  throwIfAborted: () => void;
  lifecycleTiming: Pick<CodexThreadLifecycleTimingTracker, "measure" | "mark" | "logSummary">;
  normalizeBindingModelProvider: (
    authProfileId: string | undefined,
    modelProvider: string | undefined,
  ) => string | undefined;
  bindingPatch: Partial<Omit<CodexAppServerThreadBinding, "threadId" | "pendingSupervisionBranch">>;
};

export async function materializePendingSupervisionBranch(
  params: PendingSupervisionMaterializationParams,
): Promise<CodexAppServerThreadLifecycleBinding> {
  let pending = params.binding.pendingSupervisionBranch;
  const connectionFingerprint = buildCodexAppServerConnectionFingerprint(
    params.appServer,
    params.attempt.agentDir,
  );
  if (!pending.connectionFingerprint || pending.connectionFingerprint !== connectionFingerprint) {
    throw new Error("Codex supervision source connection changed before branch materialization");
  }
  pending = await recoverPendingSupervisionArtifacts(params, pending);
  params.throwIfAborted();

  const sourceResponse = await params.lifecycleTiming.measure("supervision-source-read", () =>
    params.client.request(
      "thread/read",
      { threadId: pending.sourceThreadId, includeTurns: true },
      { signal: params.signal },
    ),
  );
  params.throwIfAborted();
  const sourceThread = sourceResponse.thread;
  if (sourceThread.id !== pending.sourceThreadId) {
    throw new Error(
      `Codex supervision source read returned ${sourceThread.id} for ${pending.sourceThreadId}`,
    );
  }
  assertPendingSupervisionSnapshotUnchanged(sourceThread, pending);
  const history = projectBoundedCodexThreadHistory({
    thread: sourceThread,
    throughTurnId: pending.lastTurnId ?? null,
    importedAt: Date.now(),
    modelProvider: sourceThread.modelProvider,
  });

  let bindingCommitted = false;
  let provisionalCleanupSafe = true;
  try {
    const probeParams = buildPendingSupervisionProbeForkParams(params, pending);
    const rawProbeResponse = await params.lifecycleTiming.measure(
      "supervision-model-probe-fork",
      async () => {
        try {
          return await params.client.request("thread/fork", probeParams, {
            signal: params.signal,
          });
        } catch (error) {
          if (!(error instanceof CodexAppServerRpcError)) {
            throw new CodexAppServerUnsafeSubscriptionError(
              "Codex model probe fork may have materialized without a response",
              { cause: error },
            );
          }
          throw error;
        }
      },
    );
    const probeThreadId = requireDistinctSupervisionThreadId({
      threadId: readSupervisionResponseThreadId(rawProbeResponse),
      sourceThreadId: pending.sourceThreadId,
      role: "model probe",
    });
    pending = await trackPendingSupervisionArtifacts(params, pending, [probeThreadId]);
    params.throwIfAborted();
    const probeResponse = assertCodexThreadForkResponse(rawProbeResponse);
    const nativeModel = requireNonBlankSupervisionValue(probeResponse.model, "native model");
    const nativeModelProvider = requireNativeSupervisionModelProvider({
      responseModelProvider: probeResponse.modelProvider,
      responseThreadModelProvider: probeResponse.thread.modelProvider,
    });

    const nativeAttempt = { ...params.attempt, modelId: nativeModel };
    const startParams = buildThreadStartParams(nativeAttempt, {
      cwd: params.cwd,
      dynamicTools: params.dynamicTools,
      appServer: params.appServer,
      developerInstructions: params.developerInstructions,
      config: params.config,
      nativeCodeModeEnabled: params.nativeCodeModeEnabled,
      nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
      nativeCodeModeOnlyEnabled: params.nativeCodeModeOnlyEnabled,
      webSearchAllowed: params.webSearchAllowed,
      environmentSelection: params.environmentSelection,
      model: nativeModel,
      modelProvider: nativeModelProvider,
    });
    assertExactSupervisionModelSelection(startParams, {
      model: nativeModel,
      modelProvider: nativeModelProvider,
      operation: "thread/start request",
    });
    const rawStartResponse = await params.lifecycleTiming.measure(
      "supervision-thread-start",
      async () => {
        try {
          return await params.client.request("thread/start", startParams, {
            signal: params.signal,
          });
        } catch (error) {
          if (error instanceof CodexAppServerRpcError) {
            throw new CodexThreadStartRequestError(error);
          }
          throw new CodexAppServerUnsafeSubscriptionError(
            "Canonical Codex branch may have started without a response",
            { cause: error },
          );
        }
      },
    );
    const finalThreadId = requireDistinctSupervisionThreadId({
      threadId: readSupervisionResponseThreadId(rawStartResponse),
      sourceThreadId: pending.sourceThreadId,
      otherThreadId: probeThreadId,
      role: "canonical branch",
    });
    pending = await trackPendingSupervisionArtifacts(params, pending, [
      probeThreadId,
      finalThreadId,
    ]);
    params.throwIfAborted();
    const startResponse = assertCodexThreadStartResponse(rawStartResponse);
    assertExactSupervisionModelSelection(startResponse, {
      model: nativeModel,
      modelProvider: nativeModelProvider,
      operation: "thread/start response",
    });
    if (history.responseItems.length > 0) {
      await params.lifecycleTiming.measure("supervision-history-inject", () =>
        params.client.request(
          "thread/inject_items",
          { threadId: finalThreadId, items: history.responseItems },
          { signal: params.signal },
        ),
      );
      params.throwIfAborted();
    }

    if (!(await archiveSupervisionArtifact(params.client, probeThreadId))) {
      throw new Error(`Failed to archive temporary Codex model probe: ${probeThreadId}`);
    }
    pending = await trackPendingSupervisionArtifacts(params, pending, [finalThreadId]);
    const historyCoveredThrough = new Date().toISOString();
    const bindingModelProvider = params.normalizeBindingModelProvider(
      params.attempt.authProfileId,
      nativeModelProvider,
    );
    let committed = false;
    try {
      committed = await params.bindingStore.mutate(params.bindingIdentity, {
        kind: "commit-pending-supervision-branch",
        expected: pending,
        threadId: finalThreadId,
        patch: {
          ...params.bindingPatch,
          model: nativeModel,
          modelProvider: bindingModelProvider,
          historyCoveredThrough,
        },
      });
    } catch (error) {
      let current: CodexAppServerThreadBinding | undefined;
      try {
        current = await params.bindingStore.read(params.bindingIdentity);
      } catch (readError) {
        provisionalCleanupSafe = false;
        throw new CodexAppServerUnsafeSubscriptionError(
          `Canonical Codex branch binding could not be verified: ${finalThreadId}`,
          { cause: new AggregateError([error, readError]) },
        );
      }
      if (
        matchesMaterializedSupervisionBranch(current, {
          sourceThreadId: pending.sourceThreadId,
          connectionFingerprint,
          threadId: finalThreadId,
          model: nativeModel,
          modelProvider: bindingModelProvider,
          historyCoveredThrough,
        })
      ) {
        committed = true;
      } else {
        if (!matchesPendingSupervisionState(current, pending)) {
          provisionalCleanupSafe = false;
          throw new CodexAppServerUnsafeSubscriptionError(
            `Canonical Codex branch binding changed while commit was uncertain: ${finalThreadId}`,
            { cause: error },
          );
        }
        throw error;
      }
    }
    if (!committed) {
      throw new CodexThreadBindingConflictError(
        pending.sourceThreadId,
        "committing a supervised Codex branch",
      );
    }
    // This thread now belongs to the durable binding. Later diagnostics must
    // never route it through provisional artifact cleanup.
    bindingCommitted = true;
    params.lifecycleTiming.mark("thread-ready");
    params.lifecycleTiming.logSummary({
      runId: params.attempt.runId,
      sessionId: params.attempt.sessionId,
      sessionKey: params.attempt.sessionKey,
      threadId: finalThreadId,
      action: "forked",
    });
    return {
      ...params.binding,
      ...params.bindingPatch,
      threadId: finalThreadId,
      pendingSupervisionBranch: undefined,
      model: nativeModel,
      modelProvider: bindingModelProvider,
      historyCoveredThrough,
      lifecycle: { action: "forked" },
    };
  } catch (error) {
    if (bindingCommitted) {
      throw error;
    }
    // The tracking CAS owner already cleaned every known artifact. Its stale
    // pending snapshot must not drive another cleanup or binding mutation.
    if (error instanceof CodexThreadBindingConflictAfterCleanupError) {
      throw error;
    }
    if (!provisionalCleanupSafe) {
      await params.abandonClient();
      throw error;
    }
    const cleanup = await cleanPendingSupervisionArtifacts(params.client, pending);
    let cleanupStateError: unknown;
    if (cleanup.remaining.length !== (pending.cleanupThreadIds?.length ?? 0)) {
      const nextPending = withPendingSupervisionCleanup(pending, cleanup.remaining);
      try {
        const updated = await params.bindingStore.mutate(params.bindingIdentity, {
          kind: "patch-pending-supervision-branch",
          expected: pending,
          pending: nextPending,
        });
        if (updated) {
          pending = nextPending;
        }
      } catch (stateError) {
        cleanupStateError = stateError;
      }
    }
    const unsafeCleanup =
      cleanup.remaining.length > 0 || isCodexAppServerUnsafeSubscriptionError(error);
    if (unsafeCleanup) {
      await params.abandonClient();
    }
    if (cleanupStateError) {
      const cause = new AggregateError([error, cleanupStateError]);
      if (unsafeCleanup) {
        throw new CodexAppServerUnsafeSubscriptionError(
          "Codex supervised branch cleanup state could not be recorded",
          { cause },
        );
      }
      const aggregateError = new AggregateError(
        [error, cleanupStateError],
        "Codex supervised branch cleanup state could not be recorded",
        { cause: error },
      );
      throw aggregateError;
    }
    if (cleanup.remaining.length > 0) {
      throw new CodexAppServerUnsafeSubscriptionError(
        `Codex supervised branch cleanup remains pending: ${cleanup.remaining.join(", ")}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function buildPendingSupervisionProbeForkParams(
  params: PendingSupervisionMaterializationParams,
  pending: CodexAppServerPendingSupervisionBranch,
): CodexThreadForkParams {
  const runtimeConfig = buildCodexRuntimeThreadConfigForRun(params.attempt, params.config, {
    nativeCodeModeEnabled: params.nativeCodeModeEnabled,
    nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
    nativeCodeModeOnlyEnabled: params.nativeCodeModeOnlyEnabled,
    webSearchAllowed: params.webSearchAllowed,
    appServer: params.appServer,
  });
  return {
    threadId: pending.sourceThreadId,
    ...(pending.lastTurnId ? { lastTurnId: pending.lastTurnId } : {}),
    cwd: params.cwd,
    approvalPolicy: params.appServer.approvalPolicy,
    approvalsReviewer: resolveCodexThreadApprovalsReviewer(params.appServer, runtimeConfig),
    ...codexThreadSandboxOrPermissions(params.appServer),
    ...(params.appServer.serviceTier !== undefined
      ? { serviceTier: params.appServer.serviceTier }
      : {}),
    config: runtimeConfig,
    developerInstructions:
      params.developerInstructions ??
      buildDeveloperInstructions(params.attempt, { dynamicTools: params.dynamicTools }),
    ephemeral: false,
    threadSource: "appServer",
    excludeTurns: true,
  };
}

function assertPendingSupervisionSnapshotUnchanged(
  thread: CodexThread,
  pending: CodexAppServerPendingSupervisionBranch,
): void {
  if (pending.lastTurnId) {
    return;
  }
  if (thread.status?.type === "active" || (thread.turns?.length ?? 0) > 0) {
    throw new Error(
      "Codex source changed after Continue; reopen the source session before sending a message",
    );
  }
}

function requireNonBlankSupervisionValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Codex supervision ${label} is missing`);
  }
  return value.trim();
}

function requireNativeSupervisionModelProvider(params: {
  responseModelProvider?: string | null;
  responseThreadModelProvider?: string | null;
}): string {
  const responseProvider = requireNonBlankSupervisionValue(
    params.responseModelProvider,
    "native model provider",
  );
  const threadProvider = params.responseThreadModelProvider?.trim();
  if (threadProvider && threadProvider !== responseProvider) {
    throw new Error(
      `Codex supervision model provider mismatch: ${responseProvider} != ${threadProvider}`,
    );
  }
  return responseProvider;
}

function assertExactSupervisionModelSelection(
  value: { model?: string | null; modelProvider?: string | null },
  expected: { model: string; modelProvider: string; operation: string },
): void {
  if (value.model !== expected.model || value.modelProvider !== expected.modelProvider) {
    throw new Error(
      `Codex supervision ${expected.operation} changed native model selection: ` +
        `${value.modelProvider ?? "unknown"}/${value.model ?? "unknown"}`,
    );
  }
}

function matchesPendingSupervisionState(
  binding: CodexAppServerThreadBinding | undefined,
  expected: CodexAppServerPendingSupervisionBranch,
): boolean {
  const pending = binding?.pendingSupervisionBranch;
  const cleanupThreadIds = pending?.cleanupThreadIds ?? [];
  const expectedCleanupThreadIds = expected.cleanupThreadIds ?? [];
  return (
    binding?.threadId === expected.sourceThreadId &&
    binding.connectionScope === "supervision" &&
    binding.supervisionSourceThreadId === expected.sourceThreadId &&
    pending?.sourceThreadId === expected.sourceThreadId &&
    pending.connectionFingerprint === expected.connectionFingerprint &&
    pending.lastTurnId === expected.lastTurnId &&
    cleanupThreadIds.length === expectedCleanupThreadIds.length &&
    cleanupThreadIds.every((threadId, index) => threadId === expectedCleanupThreadIds[index])
  );
}

function matchesMaterializedSupervisionBranch(
  binding: CodexAppServerThreadBinding | undefined,
  expected: {
    sourceThreadId: string;
    connectionFingerprint: string;
    threadId: string;
    model: string;
    modelProvider: string | undefined;
    historyCoveredThrough: string;
  },
): boolean {
  return (
    binding?.threadId === expected.threadId &&
    binding.connectionScope === "supervision" &&
    binding.supervisionSourceThreadId === expected.sourceThreadId &&
    binding.appServerRuntimeFingerprint === expected.connectionFingerprint &&
    binding.pendingSupervisionBranch === undefined &&
    binding.model === expected.model &&
    binding.modelProvider === expected.modelProvider &&
    binding.historyCoveredThrough === expected.historyCoveredThrough
  );
}

function requireDistinctSupervisionThreadId(params: {
  threadId: unknown;
  sourceThreadId: string;
  otherThreadId?: string;
  role: string;
}): string {
  let threadId: string;
  try {
    threadId = requireNonBlankSupervisionValue(params.threadId, `${params.role} thread id`);
  } catch (error) {
    throw new CodexAppServerUnsafeSubscriptionError(
      `Codex supervision ${params.role} may have materialized without a safe thread id`,
      { cause: error },
    );
  }
  if (threadId === params.sourceThreadId || threadId === params.otherThreadId) {
    throw new CodexAppServerUnsafeSubscriptionError(
      `Codex supervision ${params.role} reused an existing thread: ${threadId}`,
    );
  }
  return threadId;
}

function readSupervisionResponseThreadId(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const thread = (value as { thread?: unknown }).thread;
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
    return undefined;
  }
  return (thread as { id?: unknown }).id;
}

async function recoverPendingSupervisionArtifacts(
  params: PendingSupervisionMaterializationParams,
  pending: CodexAppServerPendingSupervisionBranch,
): Promise<CodexAppServerPendingSupervisionBranch> {
  if (!pending.cleanupThreadIds?.length) {
    return pending;
  }
  const cleanup = await cleanPendingSupervisionArtifacts(params.client, pending);
  const next = withPendingSupervisionCleanup(pending, cleanup.remaining);
  if (cleanup.remaining.length > 0) {
    if (cleanup.remaining.length !== pending.cleanupThreadIds.length) {
      const updated = await params.bindingStore.mutate(params.bindingIdentity, {
        kind: "patch-pending-supervision-branch",
        expected: pending,
        pending: next,
      });
      if (!updated) {
        throw new CodexThreadBindingConflictError(
          pending.sourceThreadId,
          "recording supervised Codex cleanup recovery",
        );
      }
    }
    throw new Error(
      `Codex supervised branch cleanup must finish before retry: ${cleanup.remaining.join(", ")}`,
    );
  }
  const updated = await params.bindingStore.mutate(params.bindingIdentity, {
    kind: "patch-pending-supervision-branch",
    expected: pending,
    pending: next,
  });
  if (!updated) {
    throw new CodexThreadBindingConflictError(
      pending.sourceThreadId,
      "recovering a supervised Codex branch",
    );
  }
  return next;
}

async function trackPendingSupervisionArtifacts(
  params: PendingSupervisionMaterializationParams,
  pending: CodexAppServerPendingSupervisionBranch,
  cleanupThreadIds: string[],
): Promise<CodexAppServerPendingSupervisionBranch> {
  const next = withPendingSupervisionCleanup(pending, cleanupThreadIds);
  const updated = await params.bindingStore.mutate(params.bindingIdentity, {
    kind: "patch-pending-supervision-branch",
    expected: pending,
    pending: next,
  });
  if (!updated) {
    const cleanupFailed: string[] = [];
    for (const threadId of cleanupThreadIds) {
      if (!(await archiveSupervisionArtifact(params.client, threadId))) {
        cleanupFailed.push(threadId);
      }
    }
    if (cleanupFailed.length > 0) {
      throw new CodexAppServerUnsafeSubscriptionError(
        `Codex supervised branch CAS cleanup failed: ${cleanupFailed.join(", ")}`,
      );
    }
    throw new CodexThreadBindingConflictAfterCleanupError(
      pending.sourceThreadId,
      "tracking supervised Codex branch cleanup",
    );
  }
  return next;
}

function withPendingSupervisionCleanup(
  pending: CodexAppServerPendingSupervisionBranch,
  cleanupThreadIds: string[],
): CodexAppServerPendingSupervisionBranch {
  return {
    sourceThreadId: pending.sourceThreadId,
    ...(pending.connectionFingerprint
      ? { connectionFingerprint: pending.connectionFingerprint }
      : {}),
    ...(pending.lastTurnId ? { lastTurnId: pending.lastTurnId } : {}),
    ...(cleanupThreadIds.length > 0 ? { cleanupThreadIds } : {}),
  };
}

async function cleanPendingSupervisionArtifacts(
  client: CodexAppServerClient,
  pending: CodexAppServerPendingSupervisionBranch,
): Promise<{ remaining: string[] }> {
  const remaining: string[] = [];
  for (const threadId of pending.cleanupThreadIds ?? []) {
    if (!(await archiveSupervisionArtifact(client, threadId))) {
      remaining.push(threadId);
    }
  }
  return { remaining };
}

async function archiveSupervisionArtifact(
  client: CodexAppServerClient,
  threadId: string,
): Promise<boolean> {
  try {
    await client.request(
      "thread/archive",
      { threadId },
      { timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS },
    );
    return true;
  } catch (error) {
    const message = formatErrorMessage(error).toLowerCase();
    if (
      message.includes("no rollout found for thread id") ||
      message.includes("thread not found") ||
      message.includes("already archived")
    ) {
      return true;
    }
    await unsubscribeCodexThreadBestEffort(client, {
      threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    });
    embeddedAgentLog.warn("failed to archive temporary Codex supervision thread", {
      threadId,
      error,
    });
    return false;
  }
}
