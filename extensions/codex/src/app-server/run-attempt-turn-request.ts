import {
  buildFactoryNativeProofHash,
  buildFactoryNativeRuntimePolicyHash,
  embeddedAgentLog,
  formatErrorMessage,
  hashFactoryNativeAuthorityValue,
  type SwarmEffectiveAuthorityProof,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  interruptCodexTurnAndWaitBestEffort,
  retireUnsafeCodexTurnClientBestEffort,
} from "./attempt-client-cleanup.js";
import {
  createCodexModelCallDiagnosticEmitter,
  utf8JsonByteLength,
} from "./attempt-diagnostics.js";
import { isCodexAppServerIndeterminateRequestCancellationError } from "./client.js";
import { assertCodexTurnStartResponse } from "./protocol-validators.js";
import {
  flattenCodexDynamicToolFunctions,
  type CodexTurnStartParams,
  type CodexTurnStartResponse,
} from "./protocol.js";
import { readCodexRateLimitsRevision } from "./rate-limit-cache.js";
import {
  emitCodexAppServerEvent,
  withCodexAppServerFastModeServiceTier,
} from "./run-attempt-lifecycle.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import {
  assertCodexFactoryNativeTurnRequestAuthority,
  buildTurnStartParams,
} from "./thread-lifecycle.js";
import { buildCodexUserPromptMessage } from "./transcript-mirror.js";

export async function prepareCodexAttemptTurnRequest(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  ensureCurrentThreadRoute: () => Promise<unknown>,
  waitForActiveNativeTurnCompletion: () => Promise<boolean>,
) {
  const { prompt, state: resourceState, releaseCurrentRoute } = resources;
  const { context, turnState, buildRenderedCodexDeveloperInstructions } = prompt;
  const { runtime, attemptTools, hookContextWindowFields, workspaceBootstrapContext } = context;
  const { connection, runtimeParams, effectiveRuntimeProviderId, effectiveRuntimeModelId } =
    runtime;
  const { tools } = attemptTools;
  const {
    params,
    usesSupervisionConnection,
    codexModelCallId,
    codexModelCallTrace,
    codexModelContentCapture,
    appServer,
    runAbortController,
  } = connection;
  const { state } = turnRuntime;
  const buildCodexModelInputMessages = () => [
    ...prompt.codexModelInputHistoryMessages,
    buildCodexUserPromptMessage({ ...runtimeParams, prompt: turnState.codexTurnPromptText }),
  ];
  const codexModelCallDiagnostics = createCodexModelCallDiagnosticEmitter({
    baseFields: {
      runId: params.runId,
      callId: codexModelCallId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      sessionId: params.sessionId,
      provider: usesSupervisionConnection
        ? (resourceState.thread.modelProvider ?? effectiveRuntimeProviderId)
        : params.provider,
      model: usesSupervisionConnection
        ? (resourceState.thread.model ?? effectiveRuntimeModelId)
        : params.modelId,
      api: usesSupervisionConnection ? runtimeParams.model.api : params.model.api,
      transport: appServer.start.transport,
      observationUnit: "turn",
      ...hookContextWindowFields,
      trace: codexModelCallTrace,
    },
    capture: codexModelContentCapture,
    tools,
    buildInputMessages: buildCodexModelInputMessages,
    buildSystemPrompt: buildRenderedCodexDeveloperInstructions,
    onErrorDiagnostic: (error) => {
      embeddedAgentLog.debug("codex app-server model call diagnostic ended with error", {
        error: formatErrorMessage(error),
      });
    },
  });
  const throwIfTurnStartAcceptedAfterAbort = () => {
    if (!runAbortController.signal.aborted) {
      return;
    }
    const reason = runAbortController.signal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    const error = new Error(
      typeof reason === "string" && reason.length > 0
        ? reason
        : "codex app-server turn start aborted before acceptance",
    );
    error.name = "AbortError";
    throw error;
  };
  const startCodexTurn = async (): Promise<CodexTurnStartResponse> => {
    const turnAppServer = withCodexAppServerFastModeServiceTier(
      connection.mutable.pluginAppServer,
      runtimeParams,
    );
    connection.mutable.pluginAppServer = turnAppServer;
    const turnStartParams = buildTurnStartParams(runtimeParams, {
      threadId: resourceState.thread.threadId,
      cwd: resourceState.codexExecutionCwd,
      appServer: turnAppServer,
      promptText: turnState.codexTurnPromptText,
      sandboxPolicy: resourceState.codexSandboxPolicy,
      environmentSelection: resourceState.codexEnvironmentSelection,
      ...(usesSupervisionConnection
        ? {}
        : { model: resourceState.thread.model, modelProvider: resourceState.thread.modelProvider }),
      turnScopedDeveloperInstructions: workspaceBootstrapContext.turnScopedDeveloperInstructions,
      skillsCollaborationInstructions: context.skillsCollaborationInstructions,
      memoryCollaborationInstructions: workspaceBootstrapContext.memoryCollaborationInstructions,
      preserveNativeTurnSettings: usesSupervisionConnection,
    });
    if (runtimeParams.factoryNativeAuthority) {
      assertCodexFactoryNativeTurnRequestAuthority(
        runtimeParams.factoryNativeAuthority.authority,
        turnStartParams,
      );
    }
    const activeTurnRoute = (await ensureCurrentThreadRoute()) as {
      armTurn(): void;
      cancelTurn(): Promise<void>;
    };
    codexModelCallDiagnostics.setRequestPayloadBytes(utf8JsonByteLength(turnStartParams));
    state.latestStartupErrorNotification = undefined;
    state.rateLimitsRevisionBeforeLastTurnStart = readCodexRateLimitsRevision(resourceState.client);
    activeTurnRoute.armTurn();
    void emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: {
        phase: "turn_starting",
        threadId: resourceState.thread.threadId,
        model: turnStartParams.model,
        effort: turnStartParams.effort,
        collaborationEffort: turnStartParams.collaborationMode?.settings.reasoning_effort,
      },
    });
    let acceptedTurnId: string | undefined;
    try {
      const startedTurn = assertCodexTurnStartResponse(
        await resourceState.client.request("turn/start", turnStartParams, {
          timeoutMs: params.timeoutMs,
          signal: runAbortController.signal,
        }),
      );
      acceptedTurnId = startedTurn.turn.id;
      await recordFactoryNativeAuthorityProof(turnStartParams);
      throwIfTurnStartAcceptedAfterAbort();
      return startedTurn;
    } catch (error) {
      if (acceptedTurnId || isCodexAppServerIndeterminateRequestCancellationError(error)) {
        // Codex serializes start/interrupt per thread; an empty id interrupts
        // the accepted native turn even when local cancellation hid its response.
        try {
          resourceState.startupClientUnsafe = !(await interruptCodexTurnAndWaitBestEffort(
            resourceState.client,
            { threadId: resourceState.thread.threadId, turnId: acceptedTurnId ?? "" },
          ));
          if (resourceState.startupClientUnsafe) {
            await retireUnsafeCodexTurnClientBestEffort(resourceState.client, "startup interrupt");
          }
        } finally {
          releaseCurrentRoute();
        }
      } else {
        await activeTurnRoute.cancelTurn();
      }
      throw error;
    }
  };

  const recordFactoryNativeAuthorityProof = async (
    turnStartParams: CodexTurnStartParams,
  ): Promise<void> => {
    const binding = params.factoryNativeAuthority;
    if (!binding) {
      return;
    }
    if (!params.onFactoryNativeAuthorityProof) {
      throw new Error("factory native Codex run has no durable authority-proof recorder");
    }
    const startup = resourceState.thread.factoryNativeStartupProof;
    const runtimeArtifact = resourceState.runtimeArtifact;
    const appServerVersion = resourceState.client.getServerVersion();
    const runtimeIdentity = resourceState.client.getRuntimeIdentity();
    if (!startup || !runtimeArtifact || !appServerVersion || !runtimeIdentity) {
      throw new Error("factory native Codex runtime attestation is incomplete");
    }
    const dynamicTools = flattenCodexDynamicToolFunctions(attemptTools.toolBridge.specs)
      .map((tool) => tool.name)
      .toSorted();
    const expectedDynamicTools = [...binding.authority.toolSurface.openClawDynamicTools].toSorted();
    if (JSON.stringify(dynamicTools) !== JSON.stringify(expectedDynamicTools)) {
      throw new Error("factory native Codex dynamic tool attestation drifted before turn/start");
    }
    let proofRuntime: SwarmEffectiveAuthorityProof["runtime"] = {
      codexVersion: appServerVersion,
      appServerVersion,
      appServerInstanceId: resourceState.client.getInstanceId(),
      ...(resourceState.client.getTransportPid()
        ? { appServerPid: resourceState.client.getTransportPid() }
        : {}),
      appServerBuildIdentity: runtimeIdentity.userAgent ?? runtimeArtifact.id,
      runtimeArtifactId: runtimeArtifact.id,
      runtimeArtifactFingerprint: runtimeArtifact.fingerprint,
      activePermissionProfile: startup.activePermissionProfile,
      sandbox: startup.sandbox,
      profileDefinitionHash: binding.authority.permissionProfile.definitionHash,
      threadConfigHash: startup.threadConfigHash,
      shellEnvironmentPolicyHash: binding.authority.shellEnvironmentPolicy.definitionHash,
      policyHash: hashFactoryNativeAuthorityValue(null),
      dynamicTools,
      cwd: startup.cwd,
      runtimeWorkspaceRoots: startup.runtimeWorkspaceRoots,
      approvalPolicy: "never",
      approvalsReviewer: startup.approvalsReviewer,
      permissionSelection: binding.authority.permissionProfile.id,
      threadStartRequestHash: startup.threadStartRequestHash,
      turnStartRequestHash: hashFactoryNativeAuthorityValue(turnStartParams),
    };
    proofRuntime = {
      ...proofRuntime,
      policyHash: buildFactoryNativeRuntimePolicyHash(proofRuntime),
    };
    const proofWithoutHash = {
      proofContractVersion: 1 as const,
      contractHash: hashFactoryNativeAuthorityValue(binding.authority),
      launchIdentityDigest: binding.launchIdentityDigest,
      runtime: proofRuntime,
      observedAt: Date.now(),
    };
    await params.onFactoryNativeAuthorityProof({
      ...proofWithoutHash,
      proofHash: buildFactoryNativeProofHash(proofWithoutHash),
    });
  };
  if (
    resourceState.thread.lifecycle.action === "resumed" &&
    (resourceState.thread.lifecycle.activeTurnIds?.length ?? 0) > 0
  ) {
    embeddedAgentLog.info(
      "codex app-server resumed thread has active native turn; waiting before turn/start",
      { threadId: resourceState.thread.threadId },
    );
    void emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: {
        phase: "turn_start_waiting_for_native_turn",
        threadId: resourceState.thread.threadId,
      },
    });
    const nativeTurnCompleted = await waitForActiveNativeTurnCompletion();
    if (nativeTurnCompleted) {
      await resourceState.turnRoute?.drain();
    } else if (!runAbortController.signal.aborted) {
      embeddedAgentLog.warn(
        "codex app-server active native turn did not complete before turn/start wait timed out",
        { threadId: resourceState.thread.threadId },
      );
    }
  }
  const buildLlmInputEvent = () => ({
    runId: params.runId,
    sessionId: params.sessionId,
    provider: usesSupervisionConnection
      ? (resourceState.thread.modelProvider ?? effectiveRuntimeProviderId)
      : params.provider,
    model: usesSupervisionConnection
      ? (resourceState.thread.model ?? effectiveRuntimeModelId)
      : params.modelId,
    systemPrompt: buildRenderedCodexDeveloperInstructions(),
    prompt: turnState.codexTurnPromptText,
    historyMessages: prompt.codexModelInputHistoryMessages,
    imagesCount: params.images?.length ?? 0,
    tools,
  });
  return { codexModelCallDiagnostics, startCodexTurn, buildLlmInputEvent };
}
