import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isIncognitoSessionKey } from "../incognito-session.js";
import { closeCodexStartupClientBestEffort } from "./attempt-client-cleanup.js";
import { resolveCodexAppServerClientInstanceId } from "./client.js";
import { applyCodexNativeSkillIsolation } from "./native-skill-isolation.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import {
  isCodexPluginThreadBindingStale,
  mergeCodexThreadConfigs,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import {
  assertCodexBindingMayBeReplaced,
  createCodexSessionGenerationSupersededError,
  normalizeCodexAppServerBindingModelProvider,
  reclaimCurrentCodexSessionGeneration,
  sessionBindingIdentity,
  type CodexAppServerBindingIdentity,
  type CodexAppServerPendingSupervisionBranch,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./shared-client.js";
import {
  isTransientWebSearchRestriction,
  shouldRecheckRecoverablePluginBinding,
  shouldRotateCodexAppServerBindingForRuntime,
  shouldRotateCodexGpt56MultiAgentBinding,
} from "./thread-binding-policy.js";
import { isContextEngineBindingCompatible } from "./thread-context-engine.js";
import {
  areDynamicToolFingerprintsCompatible,
  areUserMcpServersFingerprintsCompatible,
  shouldStartTransientNoToolThread,
} from "./thread-fingerprints.js";
import { CodexThreadBindingConflictError } from "./thread-lifecycle-errors.js";
import { resumeExistingCodexThread, startFreshCodexThread } from "./thread-lifecycle-io.js";
import { prepareCodexThreadLifecyclePreflight } from "./thread-lifecycle-preflight.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
} from "./thread-lifecycle-types.js";
import {
  releaseCodexConsumedLiveThread,
  releaseCodexRetainedLiveThread,
  throwIfCodexThreadLifecycleAborted,
  tryReuseCodexLiveThread,
} from "./thread-lifecycle-warm.js";
import { resolveCodexAppServerThreadModelSelection } from "./thread-model-selection.js";
import { materializePendingSupervisionBranch } from "./thread-supervision.js";

export async function startOrResumeThread(
  params: CodexStartOrResumeThreadParams,
): Promise<CodexAppServerThreadLifecycleBinding> {
  const incognito = isIncognitoSessionKey(params.params.sessionKey);
  const clientId = resolveCodexAppServerClientInstanceId(params.client);
  const bindingIdentity: CodexAppServerBindingIdentity = sessionBindingIdentity({
    sessionId: params.params.sessionId,
    sessionKey: params.params.sessionKey,
    agentId: params.agentId ?? params.params.agentId,
    config: params.params.config,
  });
  return await params.bindingStore.withLease(bindingIdentity, async () => {
    const {
      contextEngineBinding,
      dynamicToolsContainDeferred,
      dynamicToolsFingerprint,
      environmentSelectionFingerprint,
      hostSystemAgentActive,
      legacyDynamicToolsFingerprint,
      legacyUserMcpServersFingerprint,
      lifecycleTiming,
      nativeSkillIsolation,
      nativeSkillIsolationFingerprint,
      networkProxyConfigFingerprint,
      ringZeroActive,
      ringZeroClientInstanceId,
      ringZeroConfigFingerprint,
      ringZeroInheritedMcpServerNames,
      userMcpServersConfigPatch,
      userMcpServersFingerprint,
      webSearchThreadConfigFingerprint,
    } = await prepareCodexThreadLifecyclePreflight(params);
    let binding = await lifecycleTiming.measure("read-binding", () =>
      params.bindingStore.read(bindingIdentity),
    );
    const initialBoundThreadId = binding?.threadId;
    const initialBoundClientId = binding?.clientId;
    const normalizeBindingModelProvider = (
      authProfileId: string | undefined,
      modelProvider: string | undefined,
    ) =>
      normalizeCodexAppServerBindingModelProvider({
        authProfileId,
        modelProvider,
        authProfileStore: params.params.authProfileStore,
        agentDir: params.params.agentDir,
        config: params.params.config,
      });
    const throwIfAborted = () => throwIfCodexThreadLifecycleAborted(params.signal);
    const releaseRetainedThread = async (
      threadId: string,
      ownerClientId = initialBoundClientId,
    ) => {
      if (ownerClientId && ownerClientId !== clientId) {
        // Auth/runtime rotation selects a new physical client, but its map
        // cannot release a subscription owned by the previous app-server.
        const previousClient = retainSharedCodexAppServerClientByInstanceId(ownerClientId);
        if (!previousClient) {
          return;
        }
        try {
          await releaseCodexRetainedLiveThread({
            client: previousClient.client,
            lifecycleTiming,
            threadId,
          });
        } finally {
          previousClient.release();
        }
        return;
      }
      await releaseCodexRetainedLiveThread({
        client: params.client,
        abandonClient: params.abandonClient,
        lifecycleTiming,
        threadId,
      });
    };
    if (!binding && bindingIdentity.kind === "session" && bindingIdentity.sessionKey) {
      // Reset may rotate the OpenClaw session while this plugin is unloaded. Only
      // the authoritative session store may let its successor displace that stale owner.
      const reclaimed = await lifecycleTiming.measure("reclaim-binding-generation", () =>
        reclaimCurrentCodexSessionGeneration({
          bindingStore: params.bindingStore,
          identity: bindingIdentity,
          config: params.params.config,
        }),
      );
      if (!reclaimed) {
        throw createCodexSessionGenerationSupersededError(bindingIdentity.sessionId);
      }
    }
    if (binding?.pendingSupervisionBranch) {
      await releaseRetainedThread(binding.threadId);
      const pendingBinding = binding as CodexAppServerThreadBinding & {
        pendingSupervisionBranch: CodexAppServerPendingSupervisionBranch;
      };
      const pluginThreadConfig = params.pluginThreadConfig?.enabled
        ? await lifecycleTiming.measure("plugin-config-build", () =>
            params.pluginThreadConfig?.build(),
          )
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
      return await materializePendingSupervisionBranch({
        client: params.client,
        abandonClient:
          params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)),
        bindingStore: params.bindingStore,
        bindingIdentity,
        binding: pendingBinding,
        attempt: params.params,
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
        provisionalAppIds: pluginThreadConfig?.provisionalAppIds,
        signal: params.signal,
        throwIfAborted,
        lifecycleTiming,
        normalizeBindingModelProvider,
        bindingPatch: {
          cwd: params.cwd,
          ...(clientId ? { clientId } : {}),
          // Supervised threads stay on the native user-home connection. Never
          // persist an outer OpenClaw auth profile onto that private ownership.
          authProfileId: undefined,
          preserveNativeModel: true,
          dynamicToolsFingerprint,
          dynamicToolsContainDeferred,
          webSearchThreadConfigFingerprint,
          nativeSkillIsolationFingerprint,
          userMcpServersFingerprint,
          mcpServersFingerprint:
            params.mcpServersFingerprintEvaluated === true
              ? params.mcpServersFingerprint
              : pendingBinding.mcpServersFingerprint,
          networkProxyProfileName: params.appServer.networkProxy?.profileName,
          networkProxyConfigFingerprint,
          nativeHookRelayGeneration: finalConfigPatch.nativeHookRelayGeneration,
          appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
            params.appServer,
            params.params.agentDir,
          ),
          pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
          pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
          pluginAppPolicyContext: pluginThreadConfig?.policyContext,
          contextEngine: contextEngineBinding,
          environmentSelectionFingerprint,
          conversationSourceTransferComplete: true,
        },
      });
    }
    const clearCurrentBinding = async (operation: string) => {
      const current = binding;
      if (!current?.threadId) {
        return;
      }
      assertCodexBindingMayBeReplaced(current, operation);
      const cleared = await params.bindingStore.mutate(bindingIdentity, {
        kind: "clear",
        threadId: current.threadId,
      });
      if (!cleared) {
        throw new CodexThreadBindingConflictError(current.threadId, operation);
      }
      binding = undefined;
    };
    if (
      binding?.threadId &&
      binding.nativeSkillIsolationFingerprint !== nativeSkillIsolationFingerprint
    ) {
      embeddedAgentLog.debug(
        "codex app-server native skill isolation changed; starting a new thread",
        { threadId: binding.threadId },
      );
      await clearCurrentBinding("rotating stale native skill isolation");
    }
    if (
      binding?.threadId &&
      (binding.ringZeroConfigFingerprint !== ringZeroConfigFingerprint ||
        binding.ringZeroClientInstanceId !== ringZeroClientInstanceId) &&
      (ringZeroActive || binding.ringZeroConfigFingerprint !== undefined)
    ) {
      // Resume config cannot safely change a loaded Codex thread. Reuse a
      // ring-zero thread only when its creation-time restrictions still match.
      embeddedAgentLog.debug("codex app-server ring-zero restriction changed; rotating thread", {
        threadId: binding.threadId,
      });
      await clearCurrentBinding("rotating a ring-zero thread binding");
    }
    if (
      binding?.threadId &&
      shouldRotateCodexAppServerBindingForRuntime({
        connectionClass: params.appServer.connectionClass,
        current:
          binding.connectionScope === "supervision"
            ? buildCodexAppServerConnectionFingerprint(params.appServer, params.params.agentDir)
            : params.appServerRuntimeFingerprint,
        binding: binding.appServerRuntimeFingerprint,
      })
    ) {
      embeddedAgentLog.debug("codex app-server runtime identity changed; starting a new thread", {
        threadId: binding.threadId,
        connectionClass: params.appServer.connectionClass,
      });
      await clearCurrentBinding("rotating a stale thread binding");
      binding = undefined;
    }
    if (
      binding?.threadId &&
      shouldRotateCodexGpt56MultiAgentBinding({
        bindingModel: binding.model,
        requestedModel: params.params.modelId,
      })
    ) {
      // Codex locks the model-selected multi-agent version on the first turn.
      // Sol/Terra (V2) and Luna (V1) therefore cannot share one resumed thread.
      embeddedAgentLog.debug(
        "codex app-server GPT-5.6 multi-agent version changed; starting a new thread",
        {
          threadId: binding.threadId,
          bindingModel: binding.model,
          requestedModel: params.params.modelId,
        },
      );
      await clearCurrentBinding("rotating a GPT-5.6 multi-agent thread binding");
      binding = undefined;
    }
    const startModelSelection = resolveCodexAppServerThreadModelSelection({
      provider: params.params.provider,
      model: params.params.modelId,
      binding,
      authProfileId: params.params.authProfileId,
      authProfileStore: params.params.authProfileStore,
      agentDir: params.params.agentDir,
      config: params.params.config,
    });
    const startModelProvider = startModelSelection.modelProvider;
    // Capability read failures use managed search for this turn but must not
    // create a binding that later looks like a confirmed provider-policy change.
    const transientDelegationRestriction = params.params.delegationCapability === "report_only";
    let preserveExistingBinding =
      transientDelegationRestriction ||
      (!ringZeroActive &&
        params.nativeProviderWebSearchSupport === "unknown" &&
        !binding?.threadId);
    let rotatedContextEngineBinding = false;
    let prebuiltPluginThreadConfig: CodexPluginThreadConfig | undefined;
    const webSearchBindingChanged =
      binding?.threadId &&
      binding.webSearchThreadConfigFingerprint !== webSearchThreadConfigFingerprint;
    const persistentWebSearchRestriction =
      params.webSearchAllowed === false && params.persistentWebSearchAllowed === false;
    const transientNativeToolRestriction =
      params.nativeCodeModeEnabled === false && !persistentWebSearchRestriction;
    const transientWebSearchRestriction = isTransientWebSearchRestriction(params);
    const explicitTransientWebSearchRestriction =
      params.webSearchAllowed === false &&
      params.persistentWebSearchAllowed !== false &&
      transientWebSearchRestriction;
    const unknownProviderWebSearchSupport = params.nativeProviderWebSearchSupport === "unknown";
    if (
      binding?.threadId &&
      params.mcpServersFingerprintEvaluated === true &&
      binding.mcpServersFingerprint !== params.mcpServersFingerprint
    ) {
      assertCodexBindingMayBeReplaced(binding, "changing MCP configuration");
      if (
        !ringZeroActive &&
        (transientNativeToolRestriction ||
          (webSearchBindingChanged &&
            (explicitTransientWebSearchRestriction || unknownProviderWebSearchSupport)))
      ) {
        embeddedAgentLog.debug(
          "codex app-server MCP config changed during transient restricted turn; starting transient thread",
          {
            threadId: binding.threadId,
          },
        );
        preserveExistingBinding = true;
      } else {
        embeddedAgentLog.debug("codex app-server MCP config changed; starting a new thread", {
          threadId: binding.threadId,
        });
        await clearCurrentBinding("rotating a stale thread binding");
      }
      binding = undefined;
    }
    // A transient native-tool restriction must not replace a legacy binding just
    // because that binding predates search fingerprints. Explicit persistent
    // search denial still rotates first so the restricted thread can persist.
    const deferLegacyWebSearchRotationToTransientNativeSurface =
      params.nativeCodeModeEnabled === false &&
      binding?.webSearchThreadConfigFingerprint === undefined &&
      !persistentWebSearchRestriction;
    if (
      binding?.threadId &&
      webSearchBindingChanged &&
      !deferLegacyWebSearchRotationToTransientNativeSurface
    ) {
      assertCodexBindingMayBeReplaced(binding, "changing web-search configuration");
      if (!ringZeroActive && transientWebSearchRestriction) {
        embeddedAgentLog.debug(
          "codex app-server web search restricted for turn; starting transient thread",
          {
            threadId: binding.threadId,
          },
        );
        preserveExistingBinding = true;
      } else {
        // Codex can ignore resume overrides for a loaded thread, so persistent
        // search-policy changes and legacy bindings without metadata rotate first.
        embeddedAgentLog.debug(
          "codex app-server web search config changed; starting a new thread",
          {
            threadId: binding.threadId,
          },
        );
        await clearCurrentBinding("rotating a stale thread binding");
      }
      binding = undefined;
    }
    if (binding?.threadId && transientNativeToolRestriction && !ringZeroActive) {
      assertCodexBindingMayBeReplaced(binding, "starting a native-tool-restricted turn");
      embeddedAgentLog.debug(
        "codex app-server native tool surface disabled for turn; starting transient thread",
        {
          threadId: binding.threadId,
        },
      );
      preserveExistingBinding = true;
      binding = undefined;
    }
    if (binding?.threadId && transientDelegationRestriction) {
      assertCodexBindingMayBeReplaced(binding, "starting a delegation-restricted turn");
      // Loaded Codex threads ignore resume config overrides. Keep the normal
      // binding intact and start a transient thread with collaboration disabled.
      embeddedAgentLog.debug(
        "codex app-server delegation restricted for turn; starting transient thread",
        { threadId: binding.threadId },
      );
      binding = undefined;
    }
    if (binding?.threadId && (binding.contextEngine || contextEngineBinding)) {
      if (
        !contextEngineBinding ||
        !isContextEngineBindingCompatible(binding.contextEngine, contextEngineBinding)
      ) {
        embeddedAgentLog.debug(
          "codex app-server context-engine binding changed; starting a new thread",
          {
            threadId: binding.threadId,
            engineId: contextEngineBinding?.engineId,
            previousEngineId: binding.contextEngine?.engineId,
            epoch: contextEngineBinding?.projection?.epoch,
            previousEpoch: binding.contextEngine?.projection?.epoch,
            fingerprint: contextEngineBinding?.projection?.fingerprint,
            previousFingerprint: binding.contextEngine?.projection?.fingerprint,
            policyFingerprint: contextEngineBinding?.policyFingerprint,
            previousPolicyFingerprint: binding.contextEngine?.policyFingerprint,
          },
        );
        await clearCurrentBinding("rotating a stale thread binding");
        binding = undefined;
        rotatedContextEngineBinding = true;
      }
    }
    if (
      binding?.threadId &&
      !areUserMcpServersFingerprintsCompatible({
        previous: binding.userMcpServersFingerprint,
        next: userMcpServersFingerprint,
        nextLegacy: legacyUserMcpServersFingerprint,
      })
    ) {
      embeddedAgentLog.debug("codex app-server user MCP config changed; starting a new thread", {
        threadId: binding.threadId,
      });
      await clearCurrentBinding("rotating a stale thread binding");
      binding = undefined;
    }
    if (
      binding?.threadId &&
      binding.environmentSelectionFingerprint !== environmentSelectionFingerprint
    ) {
      embeddedAgentLog.debug(
        "codex app-server environment selection changed; starting a new thread",
        {
          threadId: binding.threadId,
        },
      );
      await clearCurrentBinding("rotating a stale thread binding");
      binding = undefined;
    }
    if (
      binding?.threadId &&
      (binding.networkProxyConfigFingerprint !== networkProxyConfigFingerprint ||
        binding.networkProxyProfileName !== params.appServer.networkProxy?.profileName)
    ) {
      embeddedAgentLog.debug(
        "codex app-server network proxy config changed; starting a new thread",
        {
          threadId: binding.threadId,
        },
      );
      await clearCurrentBinding("rotating a stale thread binding");
      binding = undefined;
    }
    if (binding?.threadId) {
      let pluginBindingStale = isCodexPluginThreadBindingStale({
        codexPluginsEnabled: params.pluginThreadConfig?.enabled ?? false,
        bindingFingerprint: binding.pluginAppsFingerprint,
        bindingInputFingerprint: binding.pluginAppsInputFingerprint,
        currentInputFingerprint: params.pluginThreadConfig?.inputFingerprint,
        hasBindingPolicyContext: Boolean(binding.pluginAppPolicyContext),
      });
      if (
        !pluginBindingStale &&
        shouldRecheckRecoverablePluginBinding({
          binding,
          pluginThreadConfig: params.pluginThreadConfig,
        })
      ) {
        try {
          prebuiltPluginThreadConfig = await lifecycleTiming.measure("plugin-config-recovery", () =>
            params.pluginThreadConfig?.build(),
          );
          pluginBindingStale =
            prebuiltPluginThreadConfig?.fingerprint !== binding.pluginAppsFingerprint;
        } catch (error) {
          embeddedAgentLog.warn("codex app-server plugin app config recovery check failed", {
            error,
            threadId: binding.threadId,
          });
        }
      }
      if (pluginBindingStale) {
        embeddedAgentLog.debug(
          "codex app-server plugin app config changed; starting a new thread",
          {
            threadId: binding.threadId,
          },
        );
        await clearCurrentBinding("rotating a stale thread binding");
        binding = undefined;
      }
    }
    if (binding?.threadId) {
      if (
        binding.dynamicToolsFingerprint &&
        params.dynamicTools.length > 0 &&
        binding.dynamicToolsContainDeferred !== dynamicToolsContainDeferred &&
        (binding.dynamicToolsContainDeferred !== undefined || !dynamicToolsContainDeferred)
      ) {
        embeddedAgentLog.debug(
          "codex app-server dynamic tool loading changed; starting a new thread",
          {
            threadId: binding.threadId,
          },
        );
        await clearCurrentBinding("rotating a stale thread binding");
        binding = undefined;
      }
    }
    if (binding?.threadId) {
      // `/codex resume <thread>` writes a binding before the next turn can know
      // the dynamic tool catalog, so only invalidate fingerprints we actually have.
      if (
        binding.dynamicToolsFingerprint &&
        !areDynamicToolFingerprintsCompatible(
          binding.dynamicToolsFingerprint,
          dynamicToolsFingerprint,
          legacyDynamicToolsFingerprint,
        )
      ) {
        assertCodexBindingMayBeReplaced(binding, "changing the dynamic tool catalog");
        preserveExistingBinding = shouldStartTransientNoToolThread({
          previous: binding.dynamicToolsFingerprint,
          nextHasDynamicTools: params.dynamicTools.length > 0,
        });
        if (preserveExistingBinding) {
          embeddedAgentLog.debug(
            "codex app-server dynamic tools unavailable for turn; starting transient thread",
            {
              threadId: binding.threadId,
            },
          );
        } else {
          embeddedAgentLog.debug(
            "codex app-server dynamic tool catalog changed; starting a new thread",
            {
              threadId: binding.threadId,
            },
          );
          await clearCurrentBinding("rotating a stale thread binding");
        }
      } else if (incognito) {
        if (binding.clientId && binding.clientId === clientId) {
          // Ephemeral threads have no cold-resume source; reuse only the live client that started it.
          params.buildFinalConfigPatch?.({ action: "resume", binding });
          throwIfAborted();
          lifecycleTiming.mark("thread-ready");
          lifecycleTiming.logSummary({
            runId: params.params.runId,
            sessionId: params.params.sessionId,
            sessionKey: params.params.sessionKey,
            threadId: binding.threadId,
            action: "resumed",
          });
          return { ...binding, lifecycle: { action: "resumed" } };
        }
        await clearCurrentBinding("rotating an unavailable ephemeral thread binding");
        binding = undefined;
      } else {
        const warmReuse = await tryReuseCodexLiveThread({
          params,
          binding,
          bindingIdentity,
          clientId,
          contextEngineBinding,
          dynamicToolsFingerprint,
          hostSystemAgentActive,
          lifecycleTiming,
          nativeSkillIsolation,
          releaseConsumedThread: (threadId, cause) =>
            releaseCodexConsumedLiveThread({
              client: params.client,
              abandonClient: params.abandonClient,
              lifecycleTiming,
              threadId,
              cause,
            }),
          ringZeroActive,
          ringZeroInheritedMcpServerNames,
          startModelProvider,
          startModelSelection,
          throwIfAborted,
          userMcpServersConfigPatch,
        });
        if (warmReuse.binding) {
          return warmReuse.binding;
        }
        // Codex cold-resumes a changed idle thread after its last subscriber
        // leaves; resume_running_thread shuts down the old cached session.
        await releaseRetainedThread(binding.threadId);
        const resumed = await resumeExistingCodexThread(params, {
          binding,
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
          ringZeroActive,
          ringZeroInheritedMcpServerNames,
          nativeSkillIsolation,
          lifecycleTiming,
          normalizeBindingModelProvider,
          throwIfAborted,
          clearCurrentBinding,
          prebuiltFinalConfigPatch: warmReuse.prebuiltFinalConfigPatch,
        });
        if (resumed) {
          return resumed;
        }
      }
    }

    if (initialBoundThreadId && !preserveExistingBinding) {
      await releaseRetainedThread(initialBoundThreadId);
    }
    return await startFreshCodexThread(params, {
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
      ringZeroActive,
      ringZeroInheritedMcpServerNames,
      nativeSkillIsolation,
      lifecycleTiming,
      normalizeBindingModelProvider,
      throwIfAborted,
      prebuiltPluginThreadConfig,
      preserveExistingBinding,
      rotatedContextEngineBinding,
    });
  });
}
