import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import { codexCatalogHomeId } from "../session-catalog-home-id.js";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
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
  attestCodexPluginThreadApps,
  discardUnattestedCodexPluginThread,
} from "./plugin-thread-attestation.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  mergeCodexThreadConfigs,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import {
  assertCodexThreadAcceptsDirectInput,
  assertCodexThreadStartResponse,
  CodexThreadDirectInputError,
} from "./protocol-validators.js";
import type { CodexThread, JsonObject } from "./protocol.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import {
  fingerprintCodexThreadConfig,
  readActiveCodexTurnIdsFromResume,
} from "./thread-fingerprints.js";
import {
  CodexAdoptedThreadActiveError,
  CodexRestrictedToolSurfaceAttestationError,
  CodexThreadBindingConflictError,
  CodexThreadStartRequestError,
} from "./thread-lifecycle-errors.js";
import { buildStartedCodexThreadBinding } from "./thread-lifecycle-result.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
  CodexThreadRequestContext,
} from "./thread-lifecycle-types.js";
import { resolveCodexAppServerModelProvider } from "./thread-model-selection.js";
import {
  attestCodexRestrictedToolSurfaceMcpServersDisabled,
  buildThreadResumeParams,
  buildThreadStartParams,
} from "./thread-requests.js";
import { resumeCodexAppServerThread } from "./thread-resume.js";

type ResumeThreadContext = CodexThreadRequestContext & {
  binding: CodexAppServerThreadBinding;
  clearCurrentBinding: (operation: string) => Promise<void>;
  prebuiltPluginThreadConfig?: CodexPluginThreadConfig;
  prebuiltFinalConfigPatch?: {
    configPatch?: JsonObject;
    nativeHookRelayGeneration?: string;
  };
  assertResumeConfiguration?: () => void;
  assertResumeOwnership?: () => void;
};

type StartThreadContext = CodexThreadRequestContext & {
  prebuiltPluginThreadConfig?: CodexPluginThreadConfig;
  preserveExistingBinding: boolean;
  rotatedContextEngineBinding: boolean;
  replacementPredecessor?: CodexAppServerThreadBinding;
};

export function resolveCodexThreadAgentDir(params: CodexStartOrResumeThreadParams): string {
  const agentId = resolveSessionAgentIdsStrict({
    config: params.params.config,
    sessionKey: params.params.sessionKey,
    agentId: params.agentId ?? params.params.agentId,
  }).sessionAgentId;
  return (
    params.agentDir ??
    params.params.agentDir ??
    resolveAgentDir(params.params.config ?? {}, agentId)
  );
}

function resolveCodexThreadRolloutPath(thread: CodexThread): string | undefined {
  const rolloutPath = thread.path?.trim();
  if (
    !rolloutPath ||
    !path.isAbsolute(rolloutPath) ||
    path.extname(rolloutPath) !== ".jsonl" ||
    !path.basename(rolloutPath).includes(thread.id)
  ) {
    return undefined;
  }
  return rolloutPath;
}

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
    // Codex rebuilds effective config on thread/resume, so replay the app
    // allowlist persisted at thread/start or plugin tools disappear after one turn.
    const pluginAppsConfigPatch =
      context.prebuiltPluginThreadConfig?.configPatch ??
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
    context.assertResumeConfiguration?.();
    if (resumeBinding.pendingResumeConfiguration) {
      await attestCodexPluginThreadApps({
        client: params.client,
        threadId: response.thread.id,
        appIds: context.prebuiltPluginThreadConfig?.provisionalAppIds ?? [],
        signal: params.signal,
      });
    }
    if (restrictedToolSurface) {
      try {
        await lifecycleTiming.measure("restricted-tool-surface-mcp-attestation", () =>
          attestCodexRestrictedToolSurfaceMcpServersDisabled(
            params.client,
            response.thread.id,
            resumeParams.config,
            params.signal,
          ),
        );
      } catch (error) {
        context.assertResumeOwnership?.();
        await abandonClient();
        throw new CodexRestrictedToolSurfaceAttestationError(error);
      }
    }
    throwIfAborted();
    const boundAuthProfileId = authProfileId;
    const nextMcpServersFingerprint =
      params.mcpServersFingerprintEvaluated === true
        ? params.mcpServersFingerprint
        : resumeBinding.mcpServersFingerprint;
    const resumePatch = {
      // Resume moves native subscription ownership to this physical client.
      // Keeping its previous client id disables warm reuse after every restart.
      clientId: resolveCodexAppServerClientInstanceId(params.client),
      pendingResumeConfiguration: undefined,
      cwd: params.cwd,
      rolloutPath: resolveCodexThreadRolloutPath(response.thread) ?? resumeBinding.rolloutPath,
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
      nativeSkillIsolationFingerprint,
      userMcpServersFingerprint,
      mcpServersFingerprint: nextMcpServersFingerprint,
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
      pluginAppsFingerprint:
        context.prebuiltPluginThreadConfig?.fingerprint ?? resumeBinding.pluginAppsFingerprint,
      pluginAppsInputFingerprint:
        context.prebuiltPluginThreadConfig?.inputFingerprint ??
        resumeBinding.pluginAppsInputFingerprint,
      pluginAppPolicyContext:
        context.prebuiltPluginThreadConfig?.policyContext ?? resumeBinding.pluginAppPolicyContext,
      contextEngine: contextEngineBinding,
      environmentSelectionFingerprint,
    } satisfies Partial<Omit<CodexAppServerThreadBinding, "threadId">>;
    const committed = await lifecycleTiming.measure("thread-resume-write-binding", () =>
      params.bindingStore.mutate(
        bindingIdentity,
        { kind: "patch", threadId: resumeBinding.threadId, patch: resumePatch },
        context.assertResumeConfiguration,
      ),
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
    if (error instanceof CodexRestrictedToolSurfaceAttestationError) {
      if (!resumeBinding.pendingResumeConfiguration) {
        await clearCurrentBinding("retiring a failed restricted-tool-surface attestation");
      }
      throw error;
    }
    if (resumeResponseAccepted) {
      const subscriptionReleased = await unsubscribeCodexThreadBestEffort(params.client, {
        threadId: resumeBinding.threadId,
        timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        assertCurrent: context.assertResumeOwnership,
      }).catch(() => false);
      if (!subscriptionReleased) {
        // Revoked cleanup authority cannot block retiring the exact client;
        // detachment leaves sibling leases alive while preventing that client from being reacquired.
        try {
          await abandonClient();
        } catch (abandonError) {
          throw new CodexAppServerUnsafeSubscriptionError(
            "Codex thread/resume client could not be retired",
            { cause: abandonError },
          );
        }
        throw new CodexAppServerUnsafeSubscriptionError(
          "Codex thread/resume subscription cleanup failed",
          { cause: error },
        );
      }
    }
    if (
      resumeBinding.pendingResumeConfiguration ||
      error instanceof CodexThreadDirectInputError ||
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
  context: StartThreadContext,
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
  // A deny-by-default app becomes callable only under this exact thread's
  // allowlist. Never persist or run the thread before Codex confirms it.
  if (provisionalAppIds?.length) {
    try {
      await lifecycleTiming.measure("plugin-app-attestation", () =>
        attestCodexPluginThreadApps({
          client: params.client,
          threadId: response.thread.id,
          appIds: provisionalAppIds,
          signal: params.signal,
        }),
      );
    } catch (error) {
      const cleanupConfirmed = await discardUnattestedCodexPluginThread({
        client: params.client,
        threadId: response.thread.id,
        ephemeral: startParams.ephemeral === true,
      });
      if (!cleanupConfirmed) {
        await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
        throw new CodexAppServerUnsafeSubscriptionError(
          "Codex plugin app attestation cleanup failed",
          { cause: error },
        );
      }
      throw error;
    }
  }
  const rolloutPath = resolveCodexThreadRolloutPath(response.thread);
  if (restrictedToolSurface) {
    try {
      await lifecycleTiming.measure("restricted-tool-surface-mcp-attestation", () =>
        attestCodexRestrictedToolSurfaceMcpServersDisabled(
          params.client,
          response.thread.id,
          startParams.config,
          params.signal,
        ),
      );
    } catch (error) {
      await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
      throw error;
    }
  }
  try {
    throwIfAborted();
  } catch (error) {
    if (replacementPredecessor) {
      const cleanupConfirmed = await discardUnattestedCodexPluginThread({
        client: params.client,
        threadId: response.thread.id,
        ephemeral: startParams.ephemeral === true,
      });
      if (!cleanupConfirmed) {
        await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
        throw new CodexAppServerUnsafeSubscriptionError(
          "Codex successor cleanup failed after an aborted binding replacement",
          { cause: error },
        );
      }
    }
    throw error;
  }
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
    const cleanupUncommittedSuccessor = async (cause?: unknown) => {
      const cleanupConfirmed = await discardUnattestedCodexPluginThread({
        client: params.client,
        threadId: response.thread.id,
        ephemeral: startParams.ephemeral === true,
      });
      if (!cleanupConfirmed) {
        await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
        throw new CodexAppServerUnsafeSubscriptionError(
          "Codex successor cleanup failed after a binding replacement conflict",
          cause === undefined ? undefined : { cause },
        );
      }
    };
    const managedSourceHomeId = codexCatalogHomeId(
      resolveCodexAppServerLocalHomeDir(params.appServer.start, resolveCodexThreadAgentDir(params)),
    );
    await lifecycleTiming.measure("thread-start-mark-managed", () =>
      markStartedCodexManagedThread(params.bindingStore.managedThreads, {
        sourceHomeId: managedSourceHomeId,
        threadId: response.thread.id,
        ...(rolloutPath ? { rolloutPath } : {}),
      }),
    );
    let committed: boolean;
    try {
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
        ),
      );
    } catch (error) {
      if (replacementPredecessor) {
        await cleanupUncommittedSuccessor(error);
      }
      throw error;
    }
    if (!committed) {
      if (replacementPredecessor) {
        await cleanupUncommittedSuccessor();
      }
      throw new CodexThreadBindingConflictError(
        replacementPredecessor?.threadId ?? response.thread.id,
        "committing a fresh thread",
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
