import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCodexAppServerForModelProvider } from "./app-server-policy.js";
import { startCodexAttemptThread } from "./attempt-startup.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import { readBoundedCodexRemoteWorkspaceFile } from "./remote-workspace-media.js";
import {
  emitCodexAppServerEvent,
  withCodexAppServerFastModeServiceTier,
} from "./run-attempt-lifecycle.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import { joinPresentSections } from "./run-attempt-state.js";
import { recordCodexTrajectoryContext } from "./trajectory.js";

export async function startCodexAttemptRuntime(resources: CodexAttemptResources) {
  const {
    prompt,
    state,
    trajectoryRecorder,
    activateNativePreToolUseFailureFallback,
    releaseSandboxExecEnvironment,
    releaseSharedClientLeaseAndRetireOneShotClient,
    releaseCurrentRoute,
    runCleanupStep,
    startupTimeoutMs,
    buildNativeHookRelayFinalConfigPatch,
  } = resources;
  const {
    context,
    turnState,
    buildRenderedCodexDeveloperInstructions,
    rebuildCodexTurnPromptTextFromCurrentProjection,
    applyNoContextEngineContinuityProjection,
  } = prompt;
  const { runtime, attemptTools, promptState } = context;
  const {
    connection,
    runtimeParams,
    preparedAuthBinding,
    buildActiveRunAttemptParams,
    startupAuthAccountCacheKey,
    startupEnvApiKeyCacheKey,
    bundleMcpThreadConfig,
    nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport,
    sandboxExecServerEnabled,
  } = runtime;
  const { toolBridge, toolState } = attemptTools;
  const developerInstructions = joinPresentSections(
    turnState.promptBuild.developerInstructions,
    attemptTools.scheduledConfiguredMcp?.diagnosticNotice,
  );
  const {
    params,
    attemptClientFactory,
    bindingStore,
    appServer,
    pluginConfig,
    computerUseConfig,
    startupClientAuthProfileId,
    runtimeArtifactRequest,
    startupPreparedAuth,
    agentDir,
    sessionAgentId,
    effectiveWorkspace,
    effectiveCwd,
    sandbox,
    runAbortController,
    usesSupervisionConnection,
    resolveReviewerPolicyContext,
    resolveRuntimeOptionsForCurrentBinding,
    startupAuthProfileId,
    startupAuthRequirement,
    abortFromUpstream,
  } = connection;
  let pluginAppServer = withCodexAppServerFastModeServiceTier(appServer, runtimeParams);
  try {
    void emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "startup" },
    });
    const startupResult = await startCodexAttemptThread({
      attemptClientFactory,
      bindingStore,
      appServer: pluginAppServer,
      pluginConfig,
      computerUseConfig,
      startupAuthProfileId: startupClientAuthProfileId,
      startupAuthRequirement,
      startupAuthBindingFingerprint: preparedAuthBinding?.fingerprint,
      ...(runtimeArtifactRequest ? { runtimeArtifactRequest } : {}),
      startupPreparedAuth,
      startupAuthAccountCacheKey,
      startupEnvApiKeyCacheKey,
      agentDir,
      config: params.config,
      buildAttemptParams: buildActiveRunAttemptParams,
      sessionAgentId,
      effectiveWorkspace,
      effectiveCwd,
      dynamicTools: toolBridge.specs,
      persistentWebSearchAllowed: toolState.persistentWebSearchAllowed,
      webSearchAllowed: toolState.webSearchAllowed,
      developerInstructions,
      buildFinalConfigPatch: buildNativeHookRelayFinalConfigPatch,
      bundleMcpThreadConfig,
      configuredMcpOwnershipVersion: attemptTools.configuredMcpOwnershipVersion,
      nativeToolSurfaceEnabled,
      nativeProviderWebSearchSupport,
      sandboxExecServerEnabled,
      sandbox,
      contextEngineProjection: promptState.contextEngineProjection,
      startupTimeoutMs,
      signal: runAbortController.signal,
      onStartupTimeout: () => runAbortController.abort("codex_startup_timeout"),
      spawnedBy: params.spawnedBy,
    });
    state.client = startupResult.client;
    state.thread = startupResult.thread;
    state.runtimeArtifact = startupResult.runtimeArtifact;
    state.turnRouter = startupResult.turnRouter;
    state.turnRoute = startupResult.turnRoute;
    // Adopt cleanup ownership before any fallible validation of the started thread.
    state.sandboxExecEnvironmentAcquired = Boolean(startupResult.sandboxEnvironment);
    state.releaseSharedClientLease = startupResult.releaseSharedClientLease;
    state.restartContextEngineCodexThread = startupResult.restartContextEngineCodexThread;
    pluginAppServer = startupResult.pluginAppServer;
    toolBridge.setRemoteWorkspaceFileReader?.(
      ({ path, maxBytes, workspaceRoot, signal, timeoutMs }) =>
        readBoundedCodexRemoteWorkspaceFile({
          client: startupResult.client,
          path,
          maxBytes,
          workspaceRoot,
          signal,
          timeoutMs,
        }),
    );
    if (
      usesSupervisionConnection &&
      (state.thread.connectionScope !== "supervision" ||
        state.thread.supervisionSourceThreadId !==
          connection.mutable.startupBinding?.supervisionSourceThreadId)
    ) {
      throw new Error("Codex supervised thread lost its private connection ownership");
    }
    if (state.thread.lifecycle.action === "started" || state.thread.lifecycle.action === "forked") {
      const activePolicy = resolveReviewerPolicyContext(state.thread);
      const activeConfig = resolveRuntimeOptionsForCurrentBinding({
        modelProvider: activePolicy.modelProvider,
        model: activePolicy.model,
      });
      const activeAppServer = resolveCodexAppServerForModelProvider({
        appServer: activeConfig,
        provider: activePolicy.modelProvider,
        model: activePolicy.model,
        config: params.config,
        env: process.env,
        agentDir,
      });
      const previousReviewer = pluginAppServer.approvalsReviewer;
      pluginAppServer = {
        ...pluginAppServer,
        approvalsReviewer: activeAppServer.approvalsReviewer,
      };
      if (pluginAppServer.approvalsReviewer !== previousReviewer) {
        embeddedAgentLog.info(
          "codex app-server approval reviewer updated from active thread model provider",
          {
            from: previousReviewer,
            to: pluginAppServer.approvalsReviewer,
            modelProvider: activePolicy.modelProvider,
          },
        );
      }
    }
    state.codexEnvironmentSelection = startupResult.environmentSelection;
    state.codexExecutionCwd = startupResult.executionCwd;
    state.codexSandboxPolicy = startupResult.sandboxPolicy;
    void emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: {
        phase: "thread_ready",
        threadId: state.thread.threadId,
        action: state.thread.lifecycle.action,
        clientId: state.client.getInstanceId(),
      },
    });
    if (applyNoContextEngineContinuityProjection(state.thread.lifecycle.action, state.thread)) {
      await rebuildCodexTurnPromptTextFromCurrentProjection();
    }
    trajectoryRecorder?.recordEvent("session.started", {
      sessionFile: params.sessionFile,
      threadId: state.thread.threadId,
      authProfileId: startupAuthProfileId,
      workspaceDir: effectiveWorkspace,
      toolCount: flattenCodexDynamicToolFunctions(toolBridge.specs).length,
    });
    recordCodexTrajectoryContext(trajectoryRecorder, {
      attempt: params,
      cwd: effectiveCwd,
      developerInstructions: joinPresentSections(
        buildRenderedCodexDeveloperInstructions(),
        attemptTools.scheduledConfiguredMcp?.diagnosticNotice,
      ),
      prompt: turnState.codexTurnPromptText,
      tools: toolBridge.availableSpecs,
    });
    connection.mutable.pluginAppServer = pluginAppServer;
  } catch (error) {
    await runCleanupStep(
      "codex-start-failure-hook-fallback",
      activateNativePreToolUseFailureFallback,
    );
    await runCleanupStep("codex-start-failure-route-release", releaseCurrentRoute);
    const nativeHookRelay = state.nativeHookRelay;
    state.nativeHookRelay = undefined;
    await runCleanupStep("codex-start-failure-native-hook-relay", () =>
      nativeHookRelay?.unregister(),
    );
    await runCleanupStep("codex-start-failure-sandbox-release", releaseSandboxExecEnvironment);
    await runCleanupStep(
      "codex-start-failure-shared-client-release",
      releaseSharedClientLeaseAndRetireOneShotClient,
    );
    await runCleanupStep("codex-start-failure-abort-listener", () =>
      params.abortSignal?.removeEventListener("abort", abortFromUpstream),
    );
    throw error;
  }
}
