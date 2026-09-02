import path from "node:path";
import type { CodexPluginThreadConfig } from "./plugin-thread-config.js";
import type { CodexThread, CodexThreadStartParams, CodexThreadStartResponse } from "./protocol.js";
import type { CodexAppServerContextEngineBinding } from "./session-binding.js";
import { fingerprintCodexThreadConfig } from "./thread-fingerprints.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
} from "./thread-lifecycle-types.js";

export function resolveCodexThreadRolloutPath(thread: CodexThread): string | undefined {
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

type StartedThreadContext = {
  contextEngineBinding?: CodexAppServerContextEngineBinding;
  dynamicToolsContainDeferred: boolean;
  dynamicToolsFingerprint: string;
  environmentSelectionFingerprint?: string;
  nativeSkillIsolationFingerprint?: string;
  networkProxyConfigFingerprint?: string;
  preserveExistingBinding: boolean;
  ringZeroClientInstanceId?: string;
  ringZeroConfigFingerprint?: string;
  rotatedContextEngineBinding: boolean;
  userMcpServersFingerprint?: string;
};

/** Materializes the public lifecycle result after a fresh thread is durably committed. */
export function buildStartedCodexThreadBinding(input: {
  bindingModelProvider?: string;
  clientId?: string;
  context: StartedThreadContext;
  finalConfigPatch: { nativeHookRelayGeneration?: string };
  nextMcpServersFingerprint?: string;
  params: CodexStartOrResumeThreadParams;
  pluginThreadConfig?: CodexPluginThreadConfig;
  response: CodexThreadStartResponse;
  rolloutPath?: string;
  startModelProvider?: string;
  startParams: CodexThreadStartParams;
  modelProvider?: string;
}): CodexAppServerThreadLifecycleBinding {
  const { context, params, response, startParams } = input;
  return {
    threadId: response.thread.id,
    ...(input.clientId ? { clientId: input.clientId } : {}),
    cwd: params.cwd,
    ...(input.rolloutPath ? { rolloutPath: input.rolloutPath } : {}),
    authProfileId: params.params.authProfileId,
    agentWorkspaceDeveloperInstructions: params.agentWorkspaceDeveloperInstructions,
    model: response.model ?? startParams.model ?? params.params.modelId,
    modelProvider: response.modelProvider ?? input.startModelProvider ?? input.modelProvider,
    dynamicToolsFingerprint: context.dynamicToolsFingerprint,
    dynamicToolsContainDeferred: context.dynamicToolsContainDeferred,
    nativeSkillIsolationFingerprint: context.nativeSkillIsolationFingerprint,
    userMcpServersFingerprint: context.userMcpServersFingerprint,
    mcpServersFingerprint: input.nextMcpServersFingerprint,
    configuredMcpOwnershipVersion: params.configuredMcpOwnershipVersion,
    ringZeroConfigFingerprint: context.ringZeroConfigFingerprint,
    ringZeroClientInstanceId: context.ringZeroClientInstanceId,
    networkProxyProfileName: params.appServer.networkProxy?.profileName,
    networkProxyConfigFingerprint: context.networkProxyConfigFingerprint,
    nativeHookRelayGeneration: input.finalConfigPatch.nativeHookRelayGeneration,
    appServerRuntimeFingerprint: params.appServerRuntimeFingerprint,
    pluginAppsFingerprint: input.pluginThreadConfig?.fingerprint,
    pluginAppsInputFingerprint: input.pluginThreadConfig?.inputFingerprint,
    pluginAppPolicyContext: input.pluginThreadConfig?.policyContext,
    contextEngine: context.contextEngineBinding,
    environmentSelectionFingerprint: context.environmentSelectionFingerprint,
    // Restricted ephemeral threads also need creation policy for fenced warm reuse.
    ...(startParams.ephemeral
      ? { liveThreadEphemeralPolicy: startParams.developerInstructions }
      : {}),
    // Transient starts do not own the persisted binding, so their native
    // subscriptions must be released instead of entering the warm cache.
    ...(!context.preserveExistingBinding
      ? {
          liveThreadConfigFingerprint: fingerprintCodexThreadConfig(
            {
              ...startParams,
              model: response.model ?? startParams.model ?? null,
              requestedModel: startParams.model ?? null,
              modelProvider: input.bindingModelProvider ?? null,
              requestedModelProvider:
                startParams.modelProvider ?? input.bindingModelProvider ?? null,
            },
            params.params.authProfileId,
            context.dynamicToolsFingerprint,
          ),
        }
      : {}),
    lifecycle: {
      action: "started",
      ...(context.rotatedContextEngineBinding ? { rotatedContextEngineBinding: true } : {}),
    },
  };
}
