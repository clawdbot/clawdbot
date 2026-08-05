import {
  embeddedAgentLog,
  formatErrorMessage,
  isHostScopedAgentToolActive,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildCodexUserMcpServersThreadConfigPatchForRuntime } from "openclaw/plugin-sdk/codex-mcp-projection";
import { getCodexAppServerClientInstanceId } from "./client.js";
import {
  isMessageOnlyCodexSourceReply,
  isSystemAgentOnlyCodexDynamicToolAllowlist,
} from "./dynamic-tool-profile.js";
import { resolveCodexNativeSkillIsolation } from "./native-skill-isolation.js";
import { isCodexAppServerProfilerEnabled } from "./profiler-flag.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
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
  assertCodexRingZeroHasNoManagedHooks,
  buildCodexRingZeroThreadConfigPatch,
  CODEX_RING_ZERO_BASE_INSTRUCTIONS,
  readCodexInheritedMcpServerNames,
} from "./thread-requests.js";
import { resolveCodexWebSearchPlan } from "./web-search.js";

export async function prepareCodexThreadLifecyclePreflight(params: CodexStartOrResumeThreadParams) {
  // Thread lifecycle spans are useful when profiling startup churn, but normal
  // turns should not pay Date.now/span-array overhead while resuming threads.
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
      : await buildCodexUserMcpServersThreadConfigPatchForRuntime(params.params.config, {
          agentId: params.agentId ?? params.params.agentId,
          agentDir: params.params.agentDir,
          allowLiteralOAuthProjection: params.appServer.connectionClass !== "remote",
          toolOverrides: params.params.toolOverrides,
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
  const restrictedToolSurface = ringZeroActive || messageOnlySourceReply;
  if (restrictedToolSurface && params.nativeCodeModeEnabled !== false) {
    throw new Error("Codex restricted tool surfaces require native code mode to be disabled");
  }
  const ringZeroInheritedMcpServerNames = restrictedToolSurface
    ? await lifecycleTiming.measure("ring-zero-mcp-config-read", () =>
        readCodexInheritedMcpServerNames(params.client, params.cwd, params.signal),
      )
    : [];
  if (restrictedToolSurface) {
    await lifecycleTiming.measure("ring-zero-config-requirements-read", () =>
      assertCodexRingZeroHasNoManagedHooks(params.client, params.signal),
    );
  }
  const ringZeroConfigFingerprint = ringZeroActive
    ? fingerprintJsonObject({
        version: 1,
        baseInstructions: CODEX_RING_ZERO_BASE_INSTRUCTIONS,
        config: buildCodexRingZeroThreadConfigPatch(
          params.params,
          true,
          ringZeroInheritedMcpServerNames,
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
    ringZeroInheritedMcpServerNames,
    userMcpServersConfigPatch,
    userMcpServersFingerprint,
    webSearchThreadConfigFingerprint,
  };
}
