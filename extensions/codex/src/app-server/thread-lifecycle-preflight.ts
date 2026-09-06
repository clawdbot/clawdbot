import {
  embeddedAgentLog,
  formatErrorMessage,
  isHostScopedAgentToolActive,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import { buildCodexUserMcpServersThreadConfigPatchForRun } from "openclaw/plugin-sdk/codex-mcp-projection";
import { getCodexAppServerClientInstanceId } from "./client.js";
import {
  CODEX_SESSION_OVERRIDABLE_LAYER_TYPES,
  readCodexEffectiveConfig,
} from "./config-layer-policy.js";
import { assertCodexModelBackedReviewerEffectiveConfig } from "./config-reviewer.js";
import {
  isMessageOnlyCodexSourceReply,
  isSystemAgentOnlyCodexDynamicToolAllowlist,
} from "./dynamic-tool-profile.js";
import { assertCodexNativeHookRelayAllowed } from "./native-hook-relay.js";
import { resolveCodexNativeSkillIsolation } from "./native-skill-isolation.js";
import { isCodexAppServerProfilerEnabled } from "./profiler-flag.js";
import { flattenCodexDynamicToolFunctions, isJsonObject } from "./protocol.js";
import { readScheduledCodexAppManagedRequirementsFingerprint } from "./scheduled-app-authority.js";
import { hashCodexAppServerBindingFingerprint } from "./session-binding.js";
import { buildContextEngineBinding } from "./thread-context-engine.js";
import {
  codexLegacyDynamicToolsFingerprint as legacyFingerprintDynamicTools,
  fingerprintEnvironmentSelection,
  fingerprintJsonObject,
  fingerprintUserMcpServersConfigPatch,
  legacyFingerprintUserMcpServersConfigPatch,
} from "./thread-fingerprints.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";
import {
  assertCodexManagedRequirementsDoNotOverrideToolPolicy,
  buildCodexRingZeroThreadConfigPatch,
  CODEX_RING_ZERO_BASE_INSTRUCTIONS,
  readCodexInheritedMcpServerNames,
} from "./thread-requests.js";
import { resolveCodexWebSearchPlan } from "./web-search.js";

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

export async function prepareCodexThreadLifecyclePreflight(params: CodexStartOrResumeThreadParams) {
  let effectiveConfig = await assertCodexModelBackedReviewerEffectiveConfig({
    client: params.client,
    approvalsReviewer: params.appServer.approvalsReviewer,
    cwd: params.cwd,
    signal: params.signal,
  });
  if (params.nativeHookRelayRequired) {
    await assertCodexNativeHookRelayAllowed(params.client, params.signal);
  }
  // Slow resumes must be diagnosable without enabling a profiler beforehand.
  const lifecycleTiming = createCodexThreadLifecycleTimingTracker({
    ...params.timing,
    enabled: params.timing?.enabled ?? isCodexAppServerProfilerEnabled(params.params.config),
  });
  const legacyDynamicToolsFingerprint = lifecycleTiming.measureSync(
    "legacy-dynamic-tools-fingerprint",
    () => legacyFingerprintDynamicTools(params.dynamicTools),
  );
  const dynamicToolsFingerprint = lifecycleTiming.measureSync("dynamic-tools-fingerprint", () =>
    hashCodexAppServerBindingFingerprint(legacyDynamicToolsFingerprint),
  );
  const dynamicToolsContainDeferred = flattenCodexDynamicToolFunctions(params.dynamicTools).some(
    (tool) => tool.deferLoading === true,
  );
  const webSearchPlan = lifecycleTiming.measureSync("web-search-plan", () =>
    resolveCodexWebSearchPlan({
      config: params.params.config,
      disableTools: params.params.disableTools,
      nativeToolSurfaceEnabled: params.nativeCodeModeEnabled,
      nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
      webSearchAllowed: params.webSearchAllowed,
    }),
  );
  const webSearchThreadConfigFingerprint = fingerprintJsonObject(webSearchPlan.threadConfig);
  const networkProxyConfigFingerprint = params.appServer.networkProxy?.configFingerprint;
  const contextEngineBinding = lifecycleTiming.measureSync("context-engine-binding", () =>
    buildContextEngineBinding(params.params, params.contextEngineProjection),
  );
  const userMcpServersConfigPatch =
    params.userMcpServersEnabled === false
      ? undefined
      : await buildCodexUserMcpServersThreadConfigPatchForRun({
          run: params.params,
          cwd: params.cwd,
          agentId: params.agentId ?? params.params.agentId,
          allowLiteralOAuthProjection: params.appServer.connectionClass !== "remote",
          warn: (message) => embeddedAgentLog.warn(message),
          onServerUnavailable: (serverName, error) =>
            embeddedAgentLog.warn("skipping unavailable MCP OAuth server", {
              serverName,
              error: formatErrorMessage(error),
            }),
        });
  const nativeSkillIsolation = await lifecycleTiming.measure("native-skill-isolation", () =>
    resolveCodexNativeSkillIsolation({
      client: params.client,
      codexHome: params.appServer.start.env?.CODEX_HOME,
      cwd: params.cwd,
      home: params.appServer.start.env?.HOME,
      signal: params.signal,
      userProfile: params.appServer.start.env?.USERPROFILE,
    }),
  );
  const nativeSkillIsolationFingerprint = nativeSkillIsolation
    ? fingerprintJsonObject({
        version: 1,
        disabledUserSkillPaths: nativeSkillIsolation.disabledUserSkillPaths,
      })
    : undefined;
  const legacyUserMcpServersFingerprint =
    legacyFingerprintUserMcpServersConfigPatch(userMcpServersConfigPatch);
  const userMcpServersFingerprint = fingerprintUserMcpServersConfigPatch(userMcpServersConfigPatch);
  const environmentSelectionFingerprint = fingerprintEnvironmentSelection(
    params.environmentSelection,
  );
  const hostSystemAgentActive =
    params.hostSystemAgentActive ?? isHostScopedAgentToolActive("openclaw");
  const ringZeroActive =
    hostSystemAgentActive && isSystemAgentOnlyCodexDynamicToolAllowlist(params.params.toolsAllow);
  const messageOnlySourceReply = isMessageOnlyCodexSourceReply(params.params);
  const restrictedToolSurface =
    ringZeroActive ||
    messageOnlySourceReply ||
    params.params.pluginHarnessToolPolicyRestricted === true;
  const allowConfiguredManagedHooks =
    params.params.pluginHarnessToolPolicyRestricted === true &&
    !ringZeroActive &&
    !messageOnlySourceReply &&
    params.params.scheduledRuntimeAuthority === undefined;
  const imageGenerationDenied =
    params.params.pluginHarnessToolPolicySafeDeniedTools?.includes("image_generate") === true;
  if (restrictedToolSurface && params.nativeCodeModeEnabled !== false) {
    throw new Error("Codex restricted tool surfaces require native code mode to be disabled");
  }
  if ((restrictedToolSurface || params.nativeCodeModeEnabled !== false) && !effectiveConfig) {
    effectiveConfig = await lifecycleTiming.measure("tool-policy-config-read", () =>
      readCodexEffectiveConfig(params.client, params.cwd, params.signal),
    );
  }
  const restrictedToolSurfaceInheritedMcpServerNames = restrictedToolSurface
    ? await lifecycleTiming.measure("restricted-tool-surface-mcp-policy", () =>
        readCodexInheritedMcpServerNames(params.client, params.cwd, params.signal, effectiveConfig),
      )
    : [];
  if (restrictedToolSurface || imageGenerationDenied || params.nativeCodeModeEnabled !== false) {
    await lifecycleTiming.measure("tool-policy-config-requirements-read", () =>
      assertCodexManagedRequirementsDoNotOverrideToolPolicy(
        params.client,
        {
          restrictedToolSurface,
          requiredNativeShell: params.nativeCodeModeEnabled !== false,
          additionalDeniedFeatures: imageGenerationDenied ? ["image_generation"] : undefined,
          allowedManagedRequirementsFingerprint:
            readScheduledCodexAppManagedRequirementsFingerprint(
              params.params.scheduledRuntimeAuthority,
            ),
          // Plugin policy restricts model-visible tools, while configured hooks are
          // administrator policy. Stricter and detached surfaces remain fail closed.
          allowConfiguredManagedHooks,
        },
        params.signal,
      ),
    );
  }
  const features = effectiveConfig?.config.features;
  // Legacy managed layers outrank session flags without appearing in requirements.
  // Their effective shell denial must fence native capture before thread startup.
  if (
    params.nativeCodeModeEnabled !== false &&
    isJsonObject(features) &&
    features.shell_tool === false &&
    !CODEX_SESSION_OVERRIDABLE_LAYER_TYPES.has(
      effectiveConfig?.origins?.["features.shell_tool"]?.name.type ?? "",
    )
  ) {
    throw new Error(
      "Codex native code mode requires shell_tool, but the effective shell setting cannot be overridden. Ask your administrator to allow the shell, or select a tool policy that disables native code mode; no automation authority was captured.",
    );
  }
  const ringZeroConfigFingerprint = ringZeroActive
    ? fingerprintJsonObject({
        version: 1,
        baseInstructions: CODEX_RING_ZERO_BASE_INSTRUCTIONS,
        config: buildCodexRingZeroThreadConfigPatch(
          params.params,
          true,
          restrictedToolSurfaceInheritedMcpServerNames,
        )!,
      })
    : undefined;
  const ringZeroClientInstanceId = ringZeroActive
    ? getCodexAppServerClientInstanceId(params.client)
    : undefined;
  return {
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
    restrictedToolSurface,
    restrictedToolSurfaceInheritedMcpServerNames,
    userMcpServersConfigPatch,
    userMcpServersFingerprint,
    webSearchThreadConfigFingerprint,
  };
}
