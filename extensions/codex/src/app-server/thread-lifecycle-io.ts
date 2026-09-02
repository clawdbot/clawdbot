import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { codexCatalogHomeId } from "../session-catalog-home-id.js";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  retireUnsafeCodexTurnClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import {
  CodexAppServerRpcError,
  isCodexAppServerOverloadError,
  resolveCodexAppServerClientInstanceId,
} from "./client.js";
import { markStartedCodexManagedThread } from "./managed-thread-store.js";
import { applyCodexNativeSkillIsolation } from "./native-skill-isolation.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import {
  attestCodexThreadToolSurface,
  discardUnattestedCodexPluginThread,
} from "./plugin-thread-attestation.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  mergeCodexThreadConfigs,
} from "./plugin-thread-config.js";
import {
  assertCodexThreadAcceptsDirectInput,
  assertCodexThreadStartResponse,
} from "./protocol-validators.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import {
  fingerprintCodexThreadConfig,
  readActiveCodexTurnIdsFromResume,
} from "./thread-fingerprints.js";
import {
  CodexAdoptedThreadActiveError,
  CodexThreadBindingConflictError,
  CodexThreadStartRequestError,
} from "./thread-lifecycle-errors.js";
import { resolveCodexThreadAgentDir } from "./thread-lifecycle-preflight.js";
import {
  buildStartedCodexThreadBinding,
  resolveCodexThreadRolloutPath,
} from "./thread-lifecycle-result.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
  CodexResumeThreadContext,
  CodexStartThreadContext,
} from "./thread-lifecycle-types.js";
import { resolveCodexAppServerModelProvider } from "./thread-model-selection.js";
import { CodexThreadPolicyHandoffError, refreshCodexThreadPolicy } from "./thread-policy.js";
import { buildThreadResumeParams, buildThreadStartParams } from "./thread-requests.js";
import { resumeCodexAppServerThread } from "./thread-resume.js";

export async function resumeExistingCodexThread(
  params: CodexStartOrResumeThreadParams,
  context: CodexResumeThreadContext,
): Promise<CodexAppServerThreadLifecycleBinding | undefined> {
  const {
    binding: resumeBinding,
    bindingIdentity,
    startModelSelection,
    startModelProvider,
    userMcpServersConfigPatch,
    dynamicToolsFingerprint,
    dynamicToolsContainDeferred,
    webSearchThreadConfigFingerprint,
    nativeSkillIsolationFingerprint,
    userMcpServersFingerprint,
    ringZeroConfigFingerprint,
    ringZeroClientInstanceId,
    networkProxyConfigFingerprint,
    contextEngineBinding,
    environmentSelectionFingerprint,
    hostSystemAgentActive,
    restrictedToolSurface,
    restrictedToolSurfaceInheritedMcpServerNames,
    nativeSkillIsolation,
    lifecycleTiming,
    normalizeBindingModelProvider,
    throwIfAborted,
    clearCurrentBinding,
  } = context;
  let resumeReservation: { release: () => void } | undefined;
  let resumeResponseAccepted = false;
  let ordinaryAppConfigChanged = false;
  let policyOutcome: CodexThreadPolicyHandoffError["outcome"] = "not-written";
  const assertHandoffCurrent = () => {
    params.params.hostCapabilities.assertActive();
    throwIfAborted();
    context.assertResumeOwnership();
    context.assertResumeConfiguration();
  };
  const abandonClient =
    params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client));
  try {
    const authProfileId =
      resumeBinding.connectionScope === "supervision"
        ? undefined
        : (params.params.authProfileId ?? resumeBinding.authProfileId);
    const finalConfigPatch = context.prebuiltFinalConfigPatch ??
      params.buildFinalConfigPatch?.({
        action: "resume",
        binding: resumeBinding,
      }) ?? {
        configPatch: params.finalConfigPatch,
        nativeHookRelayGeneration: params.nativeHookRelayGeneration,
      };
    // A cold thread has no scoped inventory yet. Build its complete config before
    // resume (including scheduled tool ceilings), then admit the loaded thread below.
    const pluginThreadConfig =
      context.prebuiltPluginThreadConfig ??
      (params.pluginThreadConfig?.requiresCurrentPolicyCheck
        ? await lifecycleTiming.measure("plugin-config-build", () =>
            params.pluginThreadConfig?.build(),
          )
        : undefined);
    const pluginAppsConfigPatch =
      pluginThreadConfig?.configPatch ??
      (params.pluginThreadConfig?.enabled && resumeBinding.pluginAppPolicyContext
        ? buildCodexPluginAppsConfigPatchFromPolicyContext(resumeBinding.pluginAppPolicyContext)
        : undefined);
    const resumeConfig = applyCodexNativeSkillIsolation(
      mergeCodexThreadConfigs(
        params.config,
        userMcpServersConfigPatch,
        pluginAppsConfigPatch,
        finalConfigPatch.configPatch,
      ),
      nativeSkillIsolation,
    );
    const resumeParams = lifecycleTiming.measureSync("thread-resume-params", () =>
      buildThreadResumeParams(params.params, {
        threadId: resumeBinding.threadId,
        cwd: params.cwd,
        authProfileId,
        model: startModelSelection.model,
        modelProvider: startModelProvider,
        preserveNativeModel: resumeBinding.preserveNativeModel === true,
        appServer: params.appServer,
        dynamicTools: params.dynamicTools,
        developerInstructions: params.developerInstructions,
        config: resumeConfig,
        nativeCodeModeEnabled: params.nativeCodeModeEnabled,
        nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
        nativeCodeModeOnlyEnabled: params.nativeCodeModeOnlyEnabled,
        webSearchAllowed: params.webSearchAllowed,
        hostSystemAgentActive,
        restrictedToolSurfaceInheritedMcpServerNames,
        shellEnvironment: params.shellEnvironment,
        disableLoginShell: params.disableLoginShell,
      }),
    );
    const requestModelProvider =
      typeof resumeParams.modelProvider === "string" && resumeParams.modelProvider.trim()
        ? resumeParams.modelProvider
        : undefined;
    // Keep ownership accounting atomic with the resume request: a
    // pre-aborted request retains no subscription, so it must not reserve.
    throwIfAborted();
    resumeReservation = params.reserveResumeThread?.(resumeBinding.threadId);
    const response = await lifecycleTiming.measure("thread-resume-request", () =>
      resumeCodexAppServerThread({
        client: params.client,
        // Retiring the exact client keeps an indeterminate resume
        // subscription from ever re-entering the shared pool.
        abandonClient,
        request: resumeParams,
        signal: params.signal,
        assertCurrent: context.assertResumeOwnership,
        isPrewriteOwnershipError: (error) => error instanceof CodexAdoptedThreadActiveError,
      }),
    );
    resumeResponseAccepted = true;
    assertCodexThreadAcceptsDirectInput(response.thread);
    context.assertResumeConfiguration();
    // Current-policy denial must release this subscription and stop, not retry
    // as a fresh thread. A confirmed config change still follows normal rotation.
    const loadedPluginThreadConfig = await context.buildLoadedPluginThreadConfig?.(resumeBinding);
    if (
      loadedPluginThreadConfig &&
      loadedPluginThreadConfig.fingerprint !==
        (pluginThreadConfig?.fingerprint ?? resumeBinding.pluginAppsFingerprint)
    ) {
      ordinaryAppConfigChanged =
        resumeBinding.connectionScope !== "supervision" &&
        !resumeBinding.pendingResumeConfiguration;
      throw new Error("Codex thread app policy changed; a fresh thread configuration is required");
    }
    const provisionalAppIds =
      loadedPluginThreadConfig?.provisionalAppIds ?? pluginThreadConfig?.provisionalAppIds ?? [];
    await attestCodexThreadToolSurface({
      client: params.client,
      threadId: response.thread.id,
      appIds: provisionalAppIds,
      signal: params.signal,
      threadConfig: resumeParams.config,
      restrictedToolSurface,
      lifecycleTiming,
      assertCurrent: assertHandoffCurrent,
    });
    throwIfAborted();
    await refreshCodexThreadPolicy({
      client: params.client,
      threadId: resumeBinding.threadId,
      developerInstructions: resumeParams.developerInstructions,
      timeoutMs: params.appServer.requestTimeoutMs,
      signal: params.signal,
      assertCurrent: assertHandoffCurrent,
    });
    policyOutcome = "acknowledged";
    assertHandoffCurrent();
    const resumePatch = {
      // Resume moves native subscription ownership to this physical client.
      // Keeping its previous client id disables warm reuse after every restart.
      clientId: resolveCodexAppServerClientInstanceId(params.client),
      pendingResumeConfiguration: undefined,
      cwd: params.cwd,
      rolloutPath: resolveCodexThreadRolloutPath(response.thread) ?? resumeBinding.rolloutPath,
      authProfileId,
      model: response.model ?? resumeParams.model ?? params.params.modelId,
      preserveNativeModel: resumeBinding.preserveNativeModel === true ? true : undefined,
      modelProvider: normalizeBindingModelProvider(
        authProfileId,
        response.modelProvider ?? requestModelProvider ?? startModelProvider,
      ),
      dynamicToolsFingerprint,
      dynamicToolsContainDeferred,
      webSearchThreadConfigFingerprint,
      nativeSkillIsolationFingerprint,
      userMcpServersFingerprint,
      mcpServersFingerprint:
        params.mcpServersFingerprintEvaluated === true
          ? params.mcpServersFingerprint
          : resumeBinding.mcpServersFingerprint,
      configuredMcpOwnershipVersion: params.configuredMcpOwnershipVersion,
      ringZeroConfigFingerprint,
      ringZeroClientInstanceId,
      nativeToolPolicyRestricted: restrictedToolSurface ? true : undefined,
      networkProxyProfileName: params.appServer.networkProxy?.profileName,
      networkProxyConfigFingerprint,
      nativeHookRelayGeneration:
        finalConfigPatch.nativeHookRelayGeneration ?? resumeBinding.nativeHookRelayGeneration,
      appServerRuntimeFingerprint:
        resumeBinding.connectionScope === "supervision"
          ? buildCodexAppServerConnectionFingerprint(params.appServer, params.params.agentDir)
          : params.appServerRuntimeFingerprint,
      pluginAppsFingerprint: pluginThreadConfig?.fingerprint ?? resumeBinding.pluginAppsFingerprint,
      pluginAppsInputFingerprint:
        pluginThreadConfig?.inputFingerprint ?? resumeBinding.pluginAppsInputFingerprint,
      pluginAppPolicyContext:
        pluginThreadConfig?.policyContext ?? resumeBinding.pluginAppPolicyContext,
      contextEngine: contextEngineBinding,
      environmentSelectionFingerprint,
    } satisfies Partial<Omit<CodexAppServerThreadBinding, "threadId">>;
    const committed = await lifecycleTiming.measure("thread-resume-write-binding", () =>
      params.bindingStore.mutate(
        bindingIdentity,
        { kind: "patch", threadId: resumeBinding.threadId, patch: resumePatch },
        assertHandoffCurrent,
      ),
    );
    if (!committed) {
      throw new CodexThreadBindingConflictError(
        resumeBinding.threadId,
        "committing a resumed thread",
      );
    }
    assertHandoffCurrent();
    if (contextEngineBinding) {
      embeddedAgentLog.info("codex app-server wrote context-engine thread binding", {
        sessionId: params.params.sessionId,
        sessionKey: params.params.sessionKey,
        threadId: response.thread.id,
        engineId: contextEngineBinding.engineId,
        epoch: contextEngineBinding.projection?.epoch,
        fingerprint: contextEngineBinding.projection?.fingerprint,
        action: "resumed",
      });
    }
    lifecycleTiming.mark("thread-ready");
    lifecycleTiming.logSummary({
      runId: params.params.runId,
      sessionId: params.params.sessionId,
      sessionKey: params.params.sessionKey,
      threadId: response.thread.id,
      action: "resumed",
    });
    const activeTurnIds = readActiveCodexTurnIdsFromResume(response);
    return {
      ...resumeBinding,
      threadId: response.thread.id,
      ...resumePatch,
      liveThreadConfigFingerprint: fingerprintCodexThreadConfig(
        {
          ...resumeParams,
          model:
            resumeBinding.preserveNativeModel === true
              ? null
              : (response.model ?? resumeParams.model ?? null),
          requestedModel:
            resumeBinding.preserveNativeModel === true ? null : (resumeParams.model ?? null),
          modelProvider:
            resumeBinding.preserveNativeModel === true ? null : (resumePatch.modelProvider ?? null),
          requestedModelProvider:
            resumeBinding.preserveNativeModel === true
              ? null
              : (resumeParams.modelProvider ?? resumePatch.modelProvider ?? null),
        },
        authProfileId,
        dynamicToolsFingerprint,
      ),
      lifecycle: {
        action: "resumed",
        ...(activeTurnIds.length ? { activeTurnIds } : {}),
      },
    };
  } catch (error) {
    resumeReservation?.release();
    // Pre-write ownership conflicts and unsafe helper outcomes cannot rotate
    // the binding. Overload is an exact pre-enqueue rejection, not a stale thread.
    if (
      !resumeResponseAccepted &&
      (!(error instanceof CodexAppServerRpcError) || isCodexAppServerOverloadError(error))
    ) {
      throw error;
    }
    if (resumeResponseAccepted) {
      const handoffError =
        error instanceof CodexThreadPolicyHandoffError ||
        error instanceof CodexAppServerUnsafeSubscriptionError
          ? error
          : new CodexThreadPolicyHandoffError(policyOutcome, error);
      // Resumed threads own native history. Release only this subscription;
      // deleting a rejected thread would also erase its history and descendants.
      const subscriptionReleased = await unsubscribeCodexThreadBestEffort(params.client, {
        threadId: resumeBinding.threadId,
        timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        assertCurrent: context.assertResumeOwnership,
      }).catch(() => false);
      if (
        !subscriptionReleased ||
        (handoffError instanceof CodexThreadPolicyHandoffError &&
          handoffError.outcome === "unknown")
      ) {
        // Revoked cleanup authority cannot block retiring the exact client;
        // detachment leaves sibling leases alive while preventing that client from being reacquired.
        if (resumeBinding.connectionScope === "supervision") {
          await retireUnsafeCodexTurnClientBestEffort(params.client, "session policy handoff");
        } else {
          try {
            await abandonClient();
          } catch (cause) {
            // A secondary cleanup failure must not erase the native policy-write outcome.
            throw new CodexThreadPolicyHandoffError(
              handoffError instanceof CodexThreadPolicyHandoffError
                ? handoffError.outcome
                : policyOutcome,
              new AggregateError(
                [handoffError, cause],
                "Codex thread/resume client could not be retired",
              ),
            );
          }
        }
      }
      // Only a confirmed ordinary app-config change may rotate after resume.
      // Supervised policy writes and failed admission never replay accepted history.
      if (!ordinaryAppConfigChanged || !subscriptionReleased) {
        throw handoffError;
      }
      assertHandoffCurrent();
    }
    if (
      resumeBinding.pendingResumeConfiguration ||
      resumeBinding.connectionScope === "supervision" ||
      params.signal?.aborted
    ) {
      throw error;
    }
    embeddedAgentLog.warn("codex app-server thread resume failed; starting a new thread", {
      error,
    });
    await clearCurrentBinding("rotating a stale thread binding");
  }

  return undefined;
}

export async function startFreshCodexThread(
  params: CodexStartOrResumeThreadParams,
  context: CodexStartThreadContext,
): Promise<CodexAppServerThreadLifecycleBinding> {
  const clientId = resolveCodexAppServerClientInstanceId(params.client);
  const {
    bindingIdentity,
    startModelSelection,
    startModelProvider,
    userMcpServersConfigPatch,
    dynamicToolsFingerprint,
    dynamicToolsContainDeferred,
    webSearchThreadConfigFingerprint,
    nativeSkillIsolationFingerprint,
    userMcpServersFingerprint,
    ringZeroConfigFingerprint,
    ringZeroClientInstanceId,
    networkProxyConfigFingerprint,
    contextEngineBinding,
    environmentSelectionFingerprint,
    hostSystemAgentActive,
    restrictedToolSurface,
    restrictedToolSurfaceInheritedMcpServerNames,
    nativeSkillIsolation,
    lifecycleTiming,
    normalizeBindingModelProvider,
    throwIfAborted,
    prebuiltPluginThreadConfig,
    preserveExistingBinding,
    rotatedContextEngineBinding,
    replacementPredecessor,
  } = context;
  const pluginThreadConfig = params.pluginThreadConfig?.enabled
    ? (prebuiltPluginThreadConfig ??
      (await lifecycleTiming.measure("plugin-config-build", () =>
        params.pluginThreadConfig?.build(),
      )))
    : undefined;
  const finalConfigPatch = params.buildFinalConfigPatch?.({ action: "start" }) ?? {
    configPatch: params.finalConfigPatch,
    nativeHookRelayGeneration: params.nativeHookRelayGeneration,
  };
  const config = lifecycleTiming.measureSync("merge-thread-config", () =>
    applyCodexNativeSkillIsolation(
      mergeCodexThreadConfigs(
        params.config,
        userMcpServersConfigPatch,
        pluginThreadConfig?.configPatch,
        finalConfigPatch.configPatch,
      ),
      nativeSkillIsolation,
    ),
  );
  const startParams = lifecycleTiming.measureSync("thread-start-params", () =>
    buildThreadStartParams(params.params, {
      cwd: params.cwd,
      dynamicTools: params.dynamicTools,
      appServer: params.appServer,
      developerInstructions: params.developerInstructions,
      config,
      nativeCodeModeEnabled: params.nativeCodeModeEnabled,
      nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
      nativeCodeModeOnlyEnabled: params.nativeCodeModeOnlyEnabled,
      webSearchAllowed: params.webSearchAllowed,
      environmentSelection: params.environmentSelection,
      model: startModelSelection.model,
      modelProvider: startModelProvider,
      hostSystemAgentActive,
      restrictedToolSurfaceInheritedMcpServerNames,
      shellEnvironment: params.shellEnvironment,
      disableLoginShell: params.disableLoginShell,
    }),
  );
  const requestModelProvider =
    typeof startParams.modelProvider === "string" && startParams.modelProvider.trim()
      ? startParams.modelProvider
      : undefined;
  const threadStartResponse = await lifecycleTiming.measure("thread-start-request", async () => {
    try {
      return await params.client.request("thread/start", startParams, { signal: params.signal });
    } catch (error) {
      if (error instanceof CodexAppServerRpcError) {
        throw new CodexThreadStartRequestError(error);
      }
      throw error;
    }
  });
  const response = assertCodexThreadStartResponse(threadStartResponse);
  const provisionalAppIds = pluginThreadConfig?.provisionalAppIds;
  const assertCurrent = () => {
    throwIfAborted();
    params.params.hostCapabilities.assertActive();
  };
  const rejectUncommittedThread = async (cause: unknown): Promise<never> => {
    const cleanupConfirmed = await discardUnattestedCodexPluginThread({
      client: params.client,
      threadId: response.thread.id,
      ephemeral: startParams.ephemeral === true,
    });
    if (!cleanupConfirmed) {
      await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
      throw new CodexAppServerUnsafeSubscriptionError("Codex uncommitted thread cleanup failed", {
        cause,
      });
    }
    throw cause;
  };
  // A deny-by-default app becomes callable only under this exact thread's
  // allowlist. Never persist or run the thread before Codex confirms it.
  try {
    await attestCodexThreadToolSurface({
      client: params.client,
      threadId: response.thread.id,
      appIds: provisionalAppIds ?? [],
      signal: params.signal,
      threadConfig: startParams.config,
      restrictedToolSurface,
      lifecycleTiming,
      assertCurrent,
    });
    assertCurrent();
  } catch (error) {
    return await rejectUncommittedThread(error);
  }
  const rolloutPath = resolveCodexThreadRolloutPath(response.thread);
  const modelProvider = resolveCodexAppServerModelProvider({
    provider: params.params.provider,
    authProfileId: params.params.authProfileId,
    authProfileStore: params.params.authProfileStore,
    agentDir: params.params.agentDir,
    config: params.params.config,
  });
  const bindingModelProvider = normalizeBindingModelProvider(
    params.params.authProfileId,
    response.modelProvider ?? requestModelProvider ?? startModelProvider ?? modelProvider,
  );
  const nextMcpServersFingerprint =
    params.mcpServersFingerprintEvaluated === true ? params.mcpServersFingerprint : undefined;
  if (!preserveExistingBinding) {
    const nextBinding: CodexAppServerThreadBinding = {
      threadId: response.thread.id,
      ...(clientId ? { clientId } : {}),
      cwd: params.cwd,
      ...(rolloutPath ? { rolloutPath } : {}),
      authProfileId: params.params.authProfileId,
      agentWorkspaceDeveloperInstructions: params.agentWorkspaceDeveloperInstructions,
      model: response.model ?? startParams.model ?? params.params.modelId,
      modelProvider: bindingModelProvider,
      dynamicToolsFingerprint,
      dynamicToolsContainDeferred,
      webSearchThreadConfigFingerprint,
      nativeSkillIsolationFingerprint,
      userMcpServersFingerprint,
      mcpServersFingerprint: nextMcpServersFingerprint,
      configuredMcpOwnershipVersion: params.configuredMcpOwnershipVersion,
      ringZeroConfigFingerprint,
      ringZeroClientInstanceId,
      nativeToolPolicyRestricted: restrictedToolSurface ? true : undefined,
      networkProxyProfileName: params.appServer.networkProxy?.profileName,
      networkProxyConfigFingerprint,
      nativeHookRelayGeneration: finalConfigPatch.nativeHookRelayGeneration,
      appServerRuntimeFingerprint: params.appServerRuntimeFingerprint,
      pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
      pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
      pluginAppPolicyContext: pluginThreadConfig?.policyContext,
      contextEngine: contextEngineBinding,
      environmentSelectionFingerprint,
    };
    const managedSourceHomeId = codexCatalogHomeId(
      resolveCodexAppServerLocalHomeDir(params.appServer.start, resolveCodexThreadAgentDir(params)),
    );
    let committed: boolean;
    try {
      await lifecycleTiming.measure("thread-start-mark-managed", () =>
        markStartedCodexManagedThread(params.bindingStore.managedThreads, {
          sourceHomeId: managedSourceHomeId,
          threadId: response.thread.id,
          ...(rolloutPath ? { rolloutPath } : {}),
        }),
      );
      committed = await lifecycleTiming.measure("thread-start-write-binding", () =>
        params.bindingStore.mutate(
          bindingIdentity,
          replacementPredecessor
            ? {
                kind: "replace-thread",
                expectedThreadId: replacementPredecessor.threadId,
                binding: nextBinding,
              }
            : { kind: "set", if: { kind: "absent" }, binding: nextBinding },
          assertCurrent,
        ),
      );
    } catch (error) {
      return await rejectUncommittedThread(error);
    }
    if (!committed) {
      return await rejectUncommittedThread(
        new CodexThreadBindingConflictError(
          replacementPredecessor?.threadId ?? response.thread.id,
          "committing a fresh thread",
        ),
      );
    }
    if (contextEngineBinding) {
      embeddedAgentLog.info("codex app-server wrote context-engine thread binding", {
        sessionId: params.params.sessionId,
        sessionKey: params.params.sessionKey,
        threadId: response.thread.id,
        engineId: contextEngineBinding.engineId,
        epoch: contextEngineBinding.projection?.epoch,
        fingerprint: contextEngineBinding.projection?.fingerprint,
        action: rotatedContextEngineBinding ? "rotated" : "started",
      });
    }
  }
  lifecycleTiming.mark("thread-ready");
  lifecycleTiming.logSummary({
    runId: params.params.runId,
    sessionId: params.params.sessionId,
    sessionKey: params.params.sessionKey,
    threadId: response.thread.id,
    action: rotatedContextEngineBinding ? "rotated" : "started",
  });
  return buildStartedCodexThreadBinding({
    bindingModelProvider,
    clientId,
    context,
    finalConfigPatch,
    nextMcpServersFingerprint,
    params,
    pluginThreadConfig,
    response,
    rolloutPath,
    startModelProvider: requestModelProvider ?? startModelProvider,
    startParams,
    modelProvider,
  });
}
