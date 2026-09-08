import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
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
import { applyCodexNativeSkillIsolation } from "./native-skill-isolation.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { attestCodexThreadToolSurface } from "./plugin-thread-attestation.js";
import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import {
  captureCodexNativeProjectInstructions,
  snapshotCodexNativeProjectInstructionSourceIdentities,
} from "./project-doc-thread-config.js";
import { assertCodexThreadAcceptsDirectInput } from "./protocol-validators.js";
import { isCodexThreadReadMissingError } from "./rpc-error.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import {
  fingerprintCodexThreadConfig,
  readActiveCodexTurnIdsFromResume,
} from "./thread-fingerprints.js";
import {
  assertCodexProjectInstructionColdResumeAllowed,
  CodexThreadBindingConflictError,
} from "./thread-lifecycle-errors.js";
import { captureAgentInstructions } from "./thread-lifecycle-instructions.js";
import { resolveCodexThreadAgentDir } from "./thread-lifecycle-preflight.js";
import { resolveCodexThreadRolloutPath } from "./thread-lifecycle-rollout.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
  CodexResumeThreadContext,
  CodexThreadResumePreparation,
} from "./thread-lifecycle-types.js";
import { CodexThreadPolicyHandoffError, refreshCodexThreadPolicy } from "./thread-policy.js";
import { buildThreadResumeParams } from "./thread-requests.js";
import { resumeCodexAppServerThread } from "./thread-resume.js";

export async function resumeExistingCodexThread(
  params: CodexStartOrResumeThreadParams,
  context: CodexResumeThreadContext,
): Promise<CodexAppServerThreadLifecycleBinding | undefined> {
  assertCodexProjectInstructionColdResumeAllowed(context.binding);
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
  let acceptedConfiguration: CodexThreadResumePreparation | undefined;
  let disposeConfiguration: (() => void) | undefined;
  let resumeReservation: { release: () => void } | undefined;
  let ordinaryAppConfigChanged = false;
  let policyOutcome: CodexThreadPolicyHandoffError["outcome"] = "not-written";
  const abandonClient =
    params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client));
  try {
    // Preparation reads must share resume recovery, before any subscription is acquired.
    const configuration = await context.prepareResume();
    const assertHandoffCurrent = configuration.assertConfigured;
    disposeConfiguration = configuration.dispose;
    await context.releaseRetainedThread(configuration.assertCurrent);
    configuration.assertCurrent();
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
      (params.pluginThreadConfig?.enabled
        ? await lifecycleTiming.measure("plugin-config-build", () =>
            params.pluginThreadConfig?.build(),
          )
        : undefined);
    const resumeConfig = applyCodexNativeSkillIsolation(
      mergeCodexThreadConfigs(
        params.config,
        userMcpServersConfigPatch,
        pluginThreadConfig?.configPatch,
        finalConfigPatch.configPatch,
        params.nativeProjectDocsDisabledOnResume ? { project_doc_max_bytes: 0 } : undefined,
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
        developerInstructions: params.coldDeveloperInstructions ?? params.developerInstructions,
        config: resumeConfig,
        nativeCodeModeEnabled: params.nativeCodeModeEnabled,
        nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
        nativeCodeModeOnlyEnabled: params.nativeCodeModeOnlyEnabled,
        webSearchAllowed: params.webSearchAllowed,
        environmentSelection: params.environmentSelection,
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
    const shouldCaptureNativeProjectInstructions =
      params.captureNativeProjectInstructions === true &&
      resumeBinding.agentWorkspaceDeveloperInstructions === undefined;
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
            config: resumeParams.config,
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
        assertCurrent: configuration.assertCurrent,
      }),
    );
    acceptedConfiguration = configuration;
    assertCodexThreadAcceptsDirectInput(response.thread);
    configuration.assertConfigured();
    if (requestModelProvider && response.modelProvider !== requestModelProvider) {
      throw new Error(
        "Codex resumed a different model provider than the one selected for this turn",
      );
    }
    let capturedAgentWorkspaceDeveloperInstructions: string | null | undefined;
    if (shouldCaptureNativeProjectInstructions) {
      if (!instructionSourceIdentitiesBeforeRequest) {
        throw new Error("Codex project instruction preflight snapshot is missing");
      }
      capturedAgentWorkspaceDeveloperInstructions =
        (await lifecycleTiming.measure("project-instructions-capture", () =>
          captureCodexNativeProjectInstructions({
            cwd: params.cwd,
            instructionSources: response.instructionSources,
            config: resumeParams.config,
            sourceIdentitiesBeforeRequest: instructionSourceIdentitiesBeforeRequest,
          }),
        )) ?? null;
      assertHandoffCurrent();
    }
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
    const resumedAgentInstructions = captureAgentInstructions(
      params,
      capturedAgentWorkspaceDeveloperInstructions !== undefined
        ? capturedAgentWorkspaceDeveloperInstructions
        : resumeBinding.agentWorkspaceDeveloperInstructions,
      response.instructionSources,
    );
    const resumePatch = {
      // Resume moves native subscription ownership to this physical client.
      // Keeping its previous client id disables warm reuse after every restart.
      clientId: resolveCodexAppServerClientInstanceId(params.client),
      pendingResumeConfiguration: undefined,
      cwd: params.cwd,
      rolloutPath: resolveCodexThreadRolloutPath(response.thread) ?? resumeBinding.rolloutPath,
      authProfileId,
      ...resumedAgentInstructions,
      // Loaded native threads can ignore resume overrides; keep the prepared model for turn/start.
      model: resumeParams.model ?? response.model ?? params.params.modelId,
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
      !acceptedConfiguration &&
      (!(error instanceof CodexAppServerRpcError) ||
        (error.method === "thread/read" &&
          !isCodexThreadReadMissingError(error, resumeBinding.threadId)) ||
        isCodexAppServerOverloadError(error))
    ) {
      throw error;
    }
    if (acceptedConfiguration) {
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
        assertCurrent: acceptedConfiguration.assertCurrent,
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
      acceptedConfiguration.assertConfigured();
    }
    if (
      resumeBinding.pendingResumeConfiguration ||
      resumeBinding.preserveNativeModel ||
      resumeBinding.connectionScope === "supervision" ||
      params.signal?.aborted
    ) {
      throw error;
    }
    embeddedAgentLog.warn("codex app-server thread resume failed; starting a new thread", {
      error,
    });
    await clearCurrentBinding("rotating a stale thread binding");
  } finally {
    disposeConfiguration?.();
  }

  return undefined;
}
