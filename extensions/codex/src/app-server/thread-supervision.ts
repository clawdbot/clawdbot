import { isDeepStrictEqual } from "node:util";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  CodexAppServerUnsafeSubscriptionError,
  isCodexAppServerUnsafeSubscriptionError,
} from "./attempt-client-cleanup.js";
import { unsubscribeCodexAppServerLiveThread } from "./client-runtime.js";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import {
  checkCodexThreadAppAvailability,
  discardUnattestedCodexPluginThread,
} from "./plugin-thread-attestation.js";
import {
  captureCodexNativeProjectInstructions,
  snapshotCodexNativeProjectInstructionSourceIdentities,
} from "./project-doc-thread-config.js";
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
  CodexThreadBindingConflictError,
  CodexThreadStartRequestError,
} from "./thread-lifecycle-errors.js";
import { captureAgentInstructions } from "./thread-lifecycle-instructions.js";
import type { CodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import type { CodexAppServerThreadLifecycleBinding } from "./thread-lifecycle-types.js";
import { buildDeveloperInstructions } from "./thread-prompt.js";
import {
  attestCodexRestrictedToolSurfaceMcpServersDisabled,
  buildCodexRuntimeThreadConfigForRun,
  buildThreadStartParams,
  codexThreadSandboxOrPermissions,
  resolveCodexThreadApprovalsReviewer,
} from "./thread-requests.js";
import {
  cleanPendingSupervisionArtifacts,
  matchesMaterializedSupervisionBranch,
  matchesPendingSupervisionState,
  readSupervisionResponseThreadId,
  recoverPendingSupervisionArtifacts,
  requireDistinctSupervisionThreadId,
  withPendingSupervisionCleanup,
} from "./thread-supervision-state.js";
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
  shellEnvironment?: Readonly<Record<string, string>>;
  disableLoginShell?: boolean;
  nativeCodeModeEnabled?: boolean;
  nativeProviderWebSearchSupport?: CodexNativeWebSearchSupport;
  nativeCodeModeOnlyEnabled?: boolean;
  webSearchAllowed?: boolean;
  hostSystemAgentActive: boolean;
  restrictedToolSurface: boolean;
  restrictedToolSurfaceInheritedMcpServerNames: string[];
  environmentSelection?: CodexTurnEnvironmentParams[];
  agentWorkspaceDeveloperInstructions?: string;
  agentWorkspaceDeveloperInstructionsAllowed?: boolean;
  captureNativeProjectInstructions?: boolean;
  projectInstructionsUnavailableToGateway?: boolean;
  signal?: AbortSignal;
  provisionalAppIds?: readonly string[];
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
  const requestOptions = { signal: params.signal, assertCurrent: params.throwIfAborted };
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
      requestOptions,
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
  let cleanupExpected: CodexAppServerPendingSupervisionBranch | undefined = pending;
  const trackPendingSupervisionArtifacts = async (cleanupThreadIds: string[]): Promise<void> => {
    const expected = pending;
    // Native creation is already a fact, even if tracking never writes or throws
    // after writing. Keep artifact ownership separate from the durable CAS snapshot.
    pending = withPendingSupervisionCleanup(pending, cleanupThreadIds);
    let updated: boolean;
    try {
      updated = await params.bindingStore.mutate(params.bindingIdentity, {
        kind: "patch-pending-supervision-branch",
        expected,
        pending,
      });
    } catch (error) {
      try {
        const current = params.bindingStore.read(params.bindingIdentity);
        if (matchesPendingSupervisionState(current, pending)) {
          cleanupExpected = pending;
        } else if (matchesPendingSupervisionState(current, expected)) {
          cleanupExpected = expected;
        } else {
          throw new CodexThreadBindingConflictError(
            pending.sourceThreadId,
            "verifying supervised Codex cleanup tracking",
          );
        }
      } catch (verificationError) {
        provisionalCleanupSafe = false;
        throw new CodexAppServerUnsafeSubscriptionError(
          `Codex supervised branch cleanup tracking could not be verified: ${cleanupThreadIds.join(", ")}`,
          { cause: new AggregateError([error, verificationError], undefined, { cause: error }) },
        );
      }
      throw error;
    }
    cleanupExpected = updated ? pending : undefined;
    if (!updated) {
      throw new CodexThreadBindingConflictError(
        pending.sourceThreadId,
        "tracking supervised Codex branch cleanup",
      );
    }
  };
  try {
    const probeParams = buildPendingSupervisionProbeForkParams(params, pending);
    const rawProbeResponse = await params.lifecycleTiming.measure(
      "supervision-model-probe-fork",
      async () => {
        try {
          return await params.client.request("thread/fork", probeParams, requestOptions);
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
    let probeResponse: ReturnType<typeof assertCodexThreadForkResponse>;
    try {
      params.throwIfAborted();
      probeResponse = assertCodexThreadForkResponse(rawProbeResponse);
      if (params.restrictedToolSurface) {
        await params.lifecycleTiming.measure("restricted-tool-surface-mcp-attestation", () =>
          attestCodexRestrictedToolSurfaceMcpServersDisabled(
            params.client,
            probeThreadId,
            probeParams.config ?? undefined,
            params.signal,
          ),
        );
      }
    } finally {
      // Ephemeral probes have no rollout to archive. Release this physical
      // subscription before creating any durable branch or cleanup artifact.
      await unsubscribeCodexAppServerLiveThread(
        params.client,
        probeThreadId,
        CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
      ).catch((cause: unknown) => {
        throw new CodexAppServerUnsafeSubscriptionError(
          `Codex model probe subscription could not be released: ${probeThreadId}`,
          { cause },
        );
      });
    }
    params.throwIfAborted();
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
      hostSystemAgentActive: params.hostSystemAgentActive,
      restrictedToolSurfaceInheritedMcpServerNames:
        params.restrictedToolSurfaceInheritedMcpServerNames,
      shellEnvironment: params.shellEnvironment,
      disableLoginShell: params.disableLoginShell,
    });
    assertExactSupervisionModelSelection(startParams, {
      model: nativeModel,
      modelProvider: nativeModelProvider,
      operation: "thread/start request",
    });
    const instructionSourceIdentitiesBeforeRequest = params.captureNativeProjectInstructions
      ? await params.lifecycleTiming.measure("project-instructions-preflight", () =>
          snapshotCodexNativeProjectInstructionSourceIdentities({
            cwd: params.cwd,
            config: startParams.config,
            environmentSelection: params.environmentSelection,
            readNativeConfig: (cwd) =>
              params.client.request(
                "config/read",
                { cwd, includeLayers: true },
                { signal: params.signal },
              ),
          }),
        )
      : undefined;
    const rawStartResponse = await params.lifecycleTiming.measure(
      "supervision-thread-start",
      async () => {
        try {
          return await params.client.request("thread/start", startParams, requestOptions);
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
    await trackPendingSupervisionArtifacts([finalThreadId]);
    params.throwIfAborted();
    const startResponse = assertCodexThreadStartResponse(rawStartResponse);
    assertExactSupervisionModelSelection(startResponse, {
      model: nativeModel,
      modelProvider: nativeModelProvider,
      operation: "thread/start response",
    });
    let capturedAgentWorkspaceDeveloperInstructions: string | null | undefined;
    if (params.captureNativeProjectInstructions) {
      if (!instructionSourceIdentitiesBeforeRequest) {
        throw new Error("Codex project instruction preflight snapshot is missing");
      }
      capturedAgentWorkspaceDeveloperInstructions =
        (await params.lifecycleTiming.measure("project-instructions-capture", () =>
          captureCodexNativeProjectInstructions({
            cwd: params.cwd,
            instructionSources: startResponse.instructionSources,
            config: startParams.config,
            sourceIdentitiesBeforeRequest: instructionSourceIdentitiesBeforeRequest,
          }),
        )) ?? null;
      params.throwIfAborted();
    }
    const projectInstructionBindingPatch = captureAgentInstructions(
      {
        params: params.attempt,
        agentWorkspaceDeveloperInstructions: params.agentWorkspaceDeveloperInstructions,
        agentWorkspaceDeveloperInstructionsAllowed:
          params.agentWorkspaceDeveloperInstructionsAllowed,
        captureNativeProjectInstructions: params.captureNativeProjectInstructions,
        projectInstructionsUnavailableToGateway: params.projectInstructionsUnavailableToGateway,
      },
      capturedAgentWorkspaceDeveloperInstructions !== undefined
        ? capturedAgentWorkspaceDeveloperInstructions
        : params.binding.agentWorkspaceDeveloperInstructions,
      startResponse.instructionSources,
    );
    const resolvedBindingPatch = {
      ...params.bindingPatch,
      ...projectInstructionBindingPatch,
    };
    if (params.restrictedToolSurface) {
      await params.lifecycleTiming.measure("restricted-tool-surface-mcp-attestation", () =>
        attestCodexRestrictedToolSurfaceMcpServersDisabled(
          params.client,
          finalThreadId,
          startParams.config,
          params.signal,
        ),
      );
    }
    if (params.provisionalAppIds?.length) {
      try {
        await params.lifecycleTiming.measure("plugin-app-attestation", () =>
          checkCodexThreadAppAvailability({
            client: params.client,
            threadId: finalThreadId,
            appIds: params.provisionalAppIds ?? [],
            signal: params.signal,
          }),
        );
      } catch (error) {
        // The fresh persistent branch has no rollout yet; delete it and
        // retain its cleanup artifact for recovery if deletion fails.
        const finalCleanupConfirmed = await discardUnattestedCodexPluginThread({
          client: params.client,
          threadId: finalThreadId,
          ephemeral: startParams.ephemeral === true,
        });
        if (!finalCleanupConfirmed) {
          provisionalCleanupSafe = false;
          throw new CodexAppServerUnsafeSubscriptionError(
            "Codex supervised plugin app attestation cleanup failed",
            { cause: error },
          );
        }
        await trackPendingSupervisionArtifacts([]);
        throw error;
      }
    }
    if (history.responseItems.length > 0) {
      await params.lifecycleTiming.measure("supervision-history-inject", () =>
        params.client.request(
          "thread/inject_items",
          { threadId: finalThreadId, items: history.responseItems },
          requestOptions,
        ),
      );
      params.throwIfAborted();
    }

    const historyCoveredThrough = new Date().toISOString();
    const bindingModelProvider = params.normalizeBindingModelProvider(
      params.attempt.authProfileId,
      nativeModelProvider,
    );
    let committed = false;
    try {
      committed = await params.bindingStore.mutate(
        params.bindingIdentity,
        {
          kind: "commit-pending-supervision-branch",
          expected: pending,
          threadId: finalThreadId,
          patch: {
            ...resolvedBindingPatch,
            model: nativeModel,
            modelProvider: bindingModelProvider,
            historyCoveredThrough,
          },
        },
        params.throwIfAborted,
      );
    } catch (error) {
      let current: CodexAppServerThreadBinding | undefined;
      try {
        current = params.bindingStore.read(params.bindingIdentity);
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
          agentWorkspaceDeveloperInstructions:
            resolvedBindingPatch.agentWorkspaceDeveloperInstructions,
          projectInstructionsUnavailableToGateway:
            resolvedBindingPatch.projectInstructionsUnavailableToGateway,
          environmentSelectionFingerprint: resolvedBindingPatch.environmentSelectionFingerprint,
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
      ...resolvedBindingPatch,
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
    if (!provisionalCleanupSafe) {
      await params.abandonClient();
      throw error;
    }
    const cleanup = await cleanPendingSupervisionArtifacts(params.client, pending);
    const nextPending = withPendingSupervisionCleanup(pending, cleanup.remaining);
    let cleanupStateError: unknown;
    // A rejected tracking CAS permits artifact compensation, never a successor write.
    if (cleanupExpected && !isDeepStrictEqual(cleanupExpected, nextPending)) {
      try {
        await params.bindingStore.mutate(params.bindingIdentity, {
          kind: "patch-pending-supervision-branch",
          expected: cleanupExpected,
          pending: nextPending,
        });
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
      const cause = new AggregateError(
        [error, cleanupStateError],
        "Codex supervised branch cleanup state could not be recorded",
        { cause: error },
      );
      if (unsafeCleanup) {
        throw new CodexAppServerUnsafeSubscriptionError(
          "Codex supervised branch cleanup state could not be recorded",
          { cause },
        );
      }
      throw cause;
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
    hostSystemAgentActive: params.hostSystemAgentActive,
    restrictedToolSurfaceInheritedMcpServerNames:
      params.restrictedToolSurfaceInheritedMcpServerNames,
    shellEnvironment: params.shellEnvironment,
    disableLoginShell: params.disableLoginShell,
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
    ephemeral: true,
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
