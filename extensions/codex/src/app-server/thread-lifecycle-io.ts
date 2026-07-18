import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  isCodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { CodexAppServerRpcError, isCodexAppServerConnectionClosedError } from "./client.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  mergeCodexThreadConfigs,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import { assertCodexThreadStartResponse } from "./protocol-validators.js";
import type { JsonObject } from "./protocol.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerContextEngineBinding,
  CodexAppServerThreadBinding,
} from "./session-binding.js";
import { isCodexAppServerStartSelectionChangedError } from "./shared-client.js";
import { readActiveCodexTurnIdsFromResume } from "./thread-fingerprints.js";
import {
  CodexAdoptedThreadActiveError,
  CodexRingZeroAttestationError,
  CodexThreadBindingConflictError,
  CodexThreadStartRequestError,
} from "./thread-lifecycle-errors.js";
import type { CodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
} from "./thread-lifecycle-types.js";
import {
  resolveCodexAppServerModelProvider,
  resolveCodexAppServerThreadModelSelection,
} from "./thread-model-selection.js";
import {
  attestCodexRingZeroThreadHasNoMcpServers,
  buildThreadResumeParams,
  buildThreadStartParams,
} from "./thread-requests.js";
import { resumeCodexAppServerThread } from "./thread-resume.js";

type ThreadRequestContext = {
  bindingIdentity: CodexAppServerBindingIdentity;
  startModelSelection: ReturnType<typeof resolveCodexAppServerThreadModelSelection>;
  startModelProvider?: string;
  userMcpServersConfigPatch?: JsonObject;
  dynamicToolsFingerprint: string;
  dynamicToolsContainDeferred: boolean;
  webSearchThreadConfigFingerprint?: string;
  userMcpServersFingerprint?: string;
  ringZeroConfigFingerprint?: string;
  ringZeroClientInstanceId?: string;
  networkProxyConfigFingerprint?: string;
  contextEngineBinding?: CodexAppServerContextEngineBinding;
  environmentSelectionFingerprint?: string;
  hostSystemAgentActive: boolean;
  ringZeroActive: boolean;
  ringZeroInheritedMcpServerNames: string[];
  lifecycleTiming: CodexThreadLifecycleTimingTracker;
  normalizeBindingModelProvider: (
    authProfileId: string | undefined,
    modelProvider: string | undefined,
  ) => string | undefined;
  throwIfAborted: () => void;
};

type ResumeThreadContext = ThreadRequestContext & {
  binding: CodexAppServerThreadBinding;
  clearCurrentBinding: (operation: string) => Promise<void>;
};

type StartThreadContext = ThreadRequestContext & {
  prebuiltPluginThreadConfig?: CodexPluginThreadConfig;
  preserveExistingBinding: boolean;
  rotatedContextEngineBinding: boolean;
};

export async function resumeExistingCodexThread(
  params: CodexStartOrResumeThreadParams,
  context: ResumeThreadContext,
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
    userMcpServersFingerprint,
    ringZeroConfigFingerprint,
    ringZeroClientInstanceId,
    networkProxyConfigFingerprint,
    contextEngineBinding,
    environmentSelectionFingerprint,
    hostSystemAgentActive,
    ringZeroActive,
    ringZeroInheritedMcpServerNames,
    lifecycleTiming,
    normalizeBindingModelProvider,
    throwIfAborted,
    clearCurrentBinding,
  } = context;
  let resumeReservation: { release: () => void } | undefined;
  try {
    const authProfileId =
      resumeBinding.connectionScope === "supervision"
        ? undefined
        : (params.params.authProfileId ?? resumeBinding.authProfileId);
    const finalConfigPatch = params.buildFinalConfigPatch?.({
      action: "resume",
      binding: resumeBinding,
    }) ?? {
      configPatch: params.finalConfigPatch,
      nativeHookRelayGeneration: params.nativeHookRelayGeneration,
    };
    // Codex rebuilds effective config on thread/resume, so replay the app
    // allowlist persisted at thread/start or plugin tools disappear after one turn.
    const pluginAppsConfigPatch =
      params.pluginThreadConfig?.enabled && resumeBinding.pluginAppPolicyContext
        ? buildCodexPluginAppsConfigPatchFromPolicyContext(resumeBinding.pluginAppPolicyContext)
        : undefined;
    const resumeConfig = mergeCodexThreadConfigs(
      params.config,
      userMcpServersConfigPatch,
      pluginAppsConfigPatch,
      finalConfigPatch.configPatch,
    );
    const resumeParams = lifecycleTiming.measureSync("thread-resume-params", () =>
      buildThreadResumeParams(params.params, {
        threadId: resumeBinding.threadId,
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
        ringZeroInheritedMcpServerNames,
      }),
    );
    const requestModelProvider =
      typeof resumeParams.modelProvider === "string" && resumeParams.modelProvider.trim()
        ? resumeParams.modelProvider
        : undefined;
    // Keep ownership accounting atomic with the resume request: a
    // pre-aborted request retains no subscription, so it must not reserve.
    throwIfAborted();
    if (resumeBinding.preserveNativeModel === true) {
      const current = await lifecycleTiming.measure("thread-read-adoption-status", () =>
        params.client.request(
          "thread/read",
          { threadId: resumeBinding.threadId, includeTurns: false },
          { signal: params.signal },
        ),
      );
      throwIfAborted();
      if (current.thread.status?.type === "active") {
        throw new CodexAdoptedThreadActiveError();
      }
    }
    resumeReservation = params.reserveResumeThread?.(resumeBinding.threadId);
    const response = await lifecycleTiming.measure("thread-resume-request", () =>
      resumeCodexAppServerThread({
        client: params.client,
        // Retiring the exact client keeps an indeterminate resume
        // subscription from ever re-entering the shared pool.
        abandonClient:
          params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)),
        request: resumeParams,
        signal: params.signal,
      }),
    );
    if (ringZeroActive) {
      try {
        await lifecycleTiming.measure("ring-zero-mcp-attestation", () =>
          attestCodexRingZeroThreadHasNoMcpServers(
            params.client,
            response.thread.id,
            params.signal,
          ),
        );
      } catch (error) {
        await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
        throw new CodexRingZeroAttestationError(error);
      }
    }
    throwIfAborted();
    const boundAuthProfileId = authProfileId;
    const nextMcpServersFingerprint =
      params.mcpServersFingerprintEvaluated === true
        ? params.mcpServersFingerprint
        : resumeBinding.mcpServersFingerprint;
    const resumePatch = {
      cwd: params.cwd,
      authProfileId: boundAuthProfileId,
      model: response.model ?? resumeParams.model ?? params.params.modelId,
      preserveNativeModel: resumeBinding.preserveNativeModel === true ? true : undefined,
      modelProvider: normalizeBindingModelProvider(
        boundAuthProfileId,
        response.modelProvider ?? requestModelProvider ?? startModelProvider,
      ),
      dynamicToolsFingerprint,
      dynamicToolsContainDeferred,
      webSearchThreadConfigFingerprint,
      userMcpServersFingerprint,
      mcpServersFingerprint: nextMcpServersFingerprint,
      ringZeroConfigFingerprint,
      ringZeroClientInstanceId,
      networkProxyProfileName: params.appServer.networkProxy?.profileName,
      networkProxyConfigFingerprint,
      nativeHookRelayGeneration:
        finalConfigPatch.nativeHookRelayGeneration ?? resumeBinding.nativeHookRelayGeneration,
      appServerRuntimeFingerprint:
        resumeBinding.connectionScope === "supervision"
          ? buildCodexAppServerConnectionFingerprint(params.appServer, params.params.agentDir)
          : params.appServerRuntimeFingerprint,
      pluginAppsFingerprint: resumeBinding.pluginAppsFingerprint,
      pluginAppsInputFingerprint: resumeBinding.pluginAppsInputFingerprint,
      pluginAppPolicyContext: resumeBinding.pluginAppPolicyContext,
      contextEngine: contextEngineBinding,
      environmentSelectionFingerprint,
    } satisfies Partial<Omit<CodexAppServerThreadBinding, "threadId">>;
    const committed = await lifecycleTiming.measure("thread-resume-write-binding", () =>
      params.bindingStore.mutate(bindingIdentity, {
        kind: "patch",
        threadId: resumeBinding.threadId,
        patch: resumePatch,
      }),
    );
    if (!committed) {
      throw new CodexThreadBindingConflictError(
        resumeBinding.threadId,
        "committing a resumed thread",
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
      lifecycle: {
        action: "resumed",
        ...(activeTurnIds.length ? { activeTurnIds } : {}),
      },
    };
  } catch (error) {
    resumeReservation?.release();
    if (isCodexAppServerStartSelectionChangedError(error)) {
      throw error;
    }
    if (error instanceof CodexRingZeroAttestationError) {
      await clearCurrentBinding("retiring a failed ring-zero thread attestation");
      throw error;
    }
    if (error instanceof CodexAdoptedThreadActiveError) {
      // The passive preflight does not subscribe, so cleanup would target
      // another runner's ownership and can turn a clear conflict into rotation.
      throw error;
    }
    if (isCodexAppServerUnsafeSubscriptionError(error)) {
      // The resume client is already retired; a fresh start here would
      // race the possibly-live subscription on the abandoned process.
      throw error;
    }
    // A structured RPC rejection proves Codex never subscribed the
    // resume, so the best-effort unsubscribe below is cosmetic for that
    // case. Only post-acceptance failures must prove the release.
    const resumeRejected = error instanceof CodexAppServerRpcError;
    const subscriptionReleased = await unsubscribeCodexThreadBestEffort(params.client, {
      threadId: resumeBinding.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    });
    if (
      !subscriptionReleased &&
      !resumeRejected &&
      !isCodexAppServerConnectionClosedError(error) &&
      !params.signal?.aborted
    ) {
      throw new CodexAppServerUnsafeSubscriptionError(
        "Codex thread/resume subscription cleanup failed",
        { cause: error },
      );
    }
    if (isCodexAppServerConnectionClosedError(error) || params.signal?.aborted) {
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
  context: StartThreadContext,
): Promise<CodexAppServerThreadLifecycleBinding> {
  const {
    bindingIdentity,
    startModelSelection,
    startModelProvider,
    userMcpServersConfigPatch,
    dynamicToolsFingerprint,
    dynamicToolsContainDeferred,
    webSearchThreadConfigFingerprint,
    userMcpServersFingerprint,
    ringZeroConfigFingerprint,
    ringZeroClientInstanceId,
    networkProxyConfigFingerprint,
    contextEngineBinding,
    environmentSelectionFingerprint,
    hostSystemAgentActive,
    ringZeroActive,
    ringZeroInheritedMcpServerNames,
    lifecycleTiming,
    normalizeBindingModelProvider,
    throwIfAborted,
    prebuiltPluginThreadConfig,
    preserveExistingBinding,
    rotatedContextEngineBinding,
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
    mergeCodexThreadConfigs(
      params.config,
      userMcpServersConfigPatch,
      pluginThreadConfig?.configPatch,
      finalConfigPatch.configPatch,
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
      ringZeroInheritedMcpServerNames,
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
  if (ringZeroActive) {
    try {
      await lifecycleTiming.measure("ring-zero-mcp-attestation", () =>
        attestCodexRingZeroThreadHasNoMcpServers(params.client, response.thread.id, params.signal),
      );
    } catch (error) {
      await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
      throw error;
    }
  }
  throwIfAborted();
  const modelProvider = resolveCodexAppServerModelProvider({
    provider: params.params.provider,
    authProfileId: params.params.authProfileId,
    authProfileStore: params.params.authProfileStore,
    agentDir: params.params.agentDir,
    config: params.params.config,
  });
  const nextMcpServersFingerprint =
    params.mcpServersFingerprintEvaluated === true ? params.mcpServersFingerprint : undefined;
  if (!preserveExistingBinding) {
    const committed = await lifecycleTiming.measure("thread-start-write-binding", () =>
      params.bindingStore.mutate(bindingIdentity, {
        kind: "set",
        if: { kind: "absent" },
        binding: {
          threadId: response.thread.id,
          cwd: params.cwd,
          authProfileId: params.params.authProfileId,
          model: response.model ?? startParams.model ?? params.params.modelId,
          modelProvider: normalizeBindingModelProvider(
            params.params.authProfileId,
            response.modelProvider ?? requestModelProvider ?? startModelProvider ?? modelProvider,
          ),
          dynamicToolsFingerprint,
          dynamicToolsContainDeferred,
          webSearchThreadConfigFingerprint,
          userMcpServersFingerprint,
          mcpServersFingerprint: nextMcpServersFingerprint,
          ringZeroConfigFingerprint,
          ringZeroClientInstanceId,
          networkProxyProfileName: params.appServer.networkProxy?.profileName,
          networkProxyConfigFingerprint,
          nativeHookRelayGeneration: finalConfigPatch.nativeHookRelayGeneration,
          appServerRuntimeFingerprint: params.appServerRuntimeFingerprint,
          pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
          pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
          pluginAppPolicyContext: pluginThreadConfig?.policyContext,
          contextEngine: contextEngineBinding,
          environmentSelectionFingerprint,
        },
      }),
    );
    if (!committed) {
      throw new CodexThreadBindingConflictError(response.thread.id, "committing a fresh thread");
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
  return {
    threadId: response.thread.id,
    cwd: params.cwd,
    authProfileId: params.params.authProfileId,
    model: response.model ?? startParams.model ?? params.params.modelId,
    modelProvider:
      response.modelProvider ?? requestModelProvider ?? startModelProvider ?? modelProvider,
    dynamicToolsFingerprint,
    dynamicToolsContainDeferred,
    userMcpServersFingerprint,
    mcpServersFingerprint: nextMcpServersFingerprint,
    ringZeroConfigFingerprint,
    ringZeroClientInstanceId,
    networkProxyProfileName: params.appServer.networkProxy?.profileName,
    networkProxyConfigFingerprint,
    nativeHookRelayGeneration: finalConfigPatch.nativeHookRelayGeneration,
    appServerRuntimeFingerprint: params.appServerRuntimeFingerprint,
    pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
    pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
    pluginAppPolicyContext: pluginThreadConfig?.policyContext,
    contextEngine: contextEngineBinding,
    environmentSelectionFingerprint,
    lifecycle: {
      action: "started",
      ...(rotatedContextEngineBinding ? { rotatedContextEngineBinding } : {}),
    },
  };
}
