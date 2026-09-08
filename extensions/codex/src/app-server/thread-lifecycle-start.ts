import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { codexCatalogHomeId } from "../session-catalog-home-id.js";
import {
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
} from "./attempt-client-cleanup.js";
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import { CodexAppServerRpcError, resolveCodexAppServerClientInstanceId } from "./client.js";
import { markStartedCodexManagedThread } from "./managed-thread-store.js";
import { applyCodexNativeSkillIsolation } from "./native-skill-isolation.js";
import {
  attestCodexThreadToolSurface,
  discardUnattestedCodexPluginThread,
} from "./plugin-thread-attestation.js";
import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import {
  captureCodexNativeProjectInstructions,
  snapshotCodexNativeProjectInstructionSourceIdentities,
} from "./project-doc-thread-config.js";
import { assertCodexThreadStartResponse } from "./protocol-validators.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { fingerprintCodexThreadConfig } from "./thread-fingerprints.js";
import {
  CodexThreadBindingConflictError,
  CodexThreadStartRequestError,
} from "./thread-lifecycle-errors.js";
import { captureAgentInstructions } from "./thread-lifecycle-instructions.js";
import { resolveCodexThreadAgentDir } from "./thread-lifecycle-preflight.js";
import { resolveCodexThreadRolloutPath } from "./thread-lifecycle-rollout.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
  CodexStartThreadContext,
} from "./thread-lifecycle-types.js";
import { resolveCodexAppServerModelProvider } from "./thread-model-selection.js";
import { buildThreadStartParams } from "./thread-requests.js";

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
        params.nativeProjectDocsDisabledOnResume ? { project_doc_max_bytes: 0 } : undefined,
      ),
      nativeSkillIsolation,
    ),
  );
  const startParams = lifecycleTiming.measureSync("thread-start-params", () =>
    buildThreadStartParams(params.params, {
      cwd: params.cwd,
      dynamicTools: params.dynamicTools,
      appServer: params.appServer,
      developerInstructions: params.coldDeveloperInstructions ?? params.developerInstructions,
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
  const assertCurrent = () => {
    throwIfAborted();
    params.params.hostCapabilities.assertActive();
    params.assertCurrent?.();
  };
  const shouldCaptureNativeProjectInstructions =
    params.captureNativeProjectInstructions === true && !preserveExistingBinding;
  const instructionSourceIdentitiesBeforeRequest = shouldCaptureNativeProjectInstructions
    ? await lifecycleTiming.measure("project-instructions-preflight", () =>
        snapshotCodexNativeProjectInstructionSourceIdentities({
          cwd: params.cwd,
          codexHome:
            params.client.getRuntimeIdentity?.()?.codexHome ??
            resolveCodexAppServerLocalHomeDir(
              params.appServer.start,
              resolveCodexThreadAgentDir(params),
            ),
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
  const threadStartResponse = await lifecycleTiming.measure("thread-start-request", async () => {
    try {
      assertCurrent();
      return await params.client.request("thread/start", startParams, {
        signal: params.signal,
        assertCurrent,
      });
    } catch (error) {
      if (error instanceof CodexAppServerRpcError) {
        throw new CodexThreadStartRequestError(error);
      }
      throw error;
    }
  });
  const response = assertCodexThreadStartResponse(threadStartResponse);
  const provisionalAppIds = pluginThreadConfig?.provisionalAppIds;
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
  let capturedAgentWorkspaceDeveloperInstructions: string | null | undefined;
  if (shouldCaptureNativeProjectInstructions) {
    if (!instructionSourceIdentitiesBeforeRequest) {
      return await rejectUncommittedThread(
        new Error("Codex project instruction preflight snapshot is missing"),
      );
    }
    try {
      capturedAgentWorkspaceDeveloperInstructions =
        (await lifecycleTiming.measure("project-instructions-capture", () =>
          captureCodexNativeProjectInstructions({
            cwd: params.cwd,
            instructionSources: response.instructionSources,
            config: startParams.config,
            sourceIdentitiesBeforeRequest: instructionSourceIdentitiesBeforeRequest,
          }),
        )) ?? null;
      assertCurrent();
    } catch (error) {
      return await rejectUncommittedThread(error);
    }
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
  const startedBinding: CodexAppServerThreadBinding = {
    threadId: response.thread.id,
    ...(clientId ? { clientId } : {}),
    cwd: params.cwd,
    ...(rolloutPath ? { rolloutPath } : {}),
    authProfileId: params.params.authProfileId,
    ...captureAgentInstructions(
      params,
      capturedAgentWorkspaceDeveloperInstructions,
      response.instructionSources,
    ),
    model: response.model ?? startParams.model ?? params.params.modelId,
    modelProvider: bindingModelProvider,
    dynamicToolsFingerprint,
    dynamicToolsContainDeferred,
    nativeSkillIsolationFingerprint,
    userMcpServersFingerprint,
    mcpServersFingerprint: nextMcpServersFingerprint,
    configuredMcpOwnershipVersion: params.configuredMcpOwnershipVersion,
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
  };
  if (!preserveExistingBinding) {
    const nextBinding: CodexAppServerThreadBinding = {
      ...startedBinding,
      webSearchThreadConfigFingerprint,
      nativeToolPolicyRestricted: restrictedToolSurface ? true : undefined,
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
  return {
    ...startedBinding,
    // Stored native-auth bindings omit redundant provider attribution; this
    // turn still reports the provider selected by the native runtime.
    modelProvider:
      response.modelProvider ?? requestModelProvider ?? startModelProvider ?? modelProvider,
    // Restricted ephemeral threads also need creation policy for fenced warm reuse.
    ...(startParams.ephemeral
      ? { liveThreadEphemeralPolicy: startParams.developerInstructions }
      : {}),
    // Transient starts do not own the persisted binding, so their native
    // subscriptions must be released instead of entering the warm cache.
    ...(!preserveExistingBinding
      ? {
          liveThreadConfigFingerprint: fingerprintCodexThreadConfig(
            {
              ...startParams,
              model: response.model ?? startParams.model ?? null,
              requestedModel: startParams.model ?? null,
              modelProvider: bindingModelProvider ?? null,
              requestedModelProvider: startParams.modelProvider ?? bindingModelProvider ?? null,
            },
            params.params.authProfileId,
            dynamicToolsFingerprint,
          ),
        }
      : {}),
    lifecycle: {
      action: "started",
      ...(rotatedContextEngineBinding ? { rotatedContextEngineBinding: true } : {}),
    },
  };
}
