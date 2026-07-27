import {
  assertContextEngineHostSupport,
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  embeddedAgentLog,
  loadCodexBundleMcpThreadConfig,
  supportsModelTools,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { prepareCodexAppServerAuthBinding } from "./auth-binding.js";
import {
  resolveCodexAppServerAuthAccountCacheKey,
  resolveCodexAppServerFallbackApiKeyCacheKey,
  resolveCodexAppServerPreparedApiKeyCacheKey,
} from "./auth-bridge.js";
import { isCodexSandboxExecServerEnabled } from "./config.js";
import {
  resolveCodexAppServerHookChannelId,
  shouldEnableCodexAppServerNativeToolSurface,
} from "./dynamic-tool-build.js";
import { resolveCodexProviderWebSearchSupport } from "./provider-capabilities.js";
import type { CodexAttemptConnection } from "./run-attempt-connection.js";
import { resolveCodexAppServerThreadModelSelection } from "./thread-lifecycle.js";
import { resolveCodexWebSearchPlan } from "./web-search.js";

export async function prepareCodexAttemptRuntime(connection: CodexAttemptConnection) {
  const {
    params,
    pluginConfig,
    usesSupervisionConnection,
    appServer,
    startupAuthProfileId,
    startupPreparedAuth,
    startupClientAuthProfileId,
    agentDir,
    preDynamicStartupStages,
    effectiveWorkspace,
    contextSessionKey,
    sandboxSessionKey,
    sessionAgentId,
    sandbox,
    attemptClientFactory,
    runAbortController,
    activeContextEngine,
    mutable,
  } = connection;
  const preparedAuthBinding =
    !usesSupervisionConnection && appServer.start.homeScope !== "user" && startupAuthProfileId
      ? await prepareCodexAppServerAuthBinding({
          authProfileId: startupAuthProfileId,
          authProfileStore: params.authProfileStore,
          agentDir,
          config: params.config,
        })
      : undefined;
  const attemptAuthProfileStore = preparedAuthBinding?.authProfileStore ?? params.authProfileStore;
  const effectiveContextWindowInfo = usesSupervisionConnection
    ? undefined
    : params.contextWindowInfo;
  const effectiveContextTokenBudget = usesSupervisionConnection
    ? undefined
    : params.contextTokenBudget;
  const effectiveRuntimeProviderId = usesSupervisionConnection
    ? (mutable.startupBinding?.modelProvider ?? "codex")
    : params.provider;
  const effectiveRuntimeModelId = usesSupervisionConnection
    ? (mutable.startupBinding?.model ?? "codex-native")
    : params.modelId;
  const {
    authProfileId: _outerAuthProfileId,
    contextWindowInfo: _outerContextWindowInfo,
    contextTokenBudget: _outerContextTokenBudget,
    model: _outerModel,
    modelId: _outerModelId,
    provider: _outerProvider,
    runtimePlan: _outerRuntimePlan,
    requestedModelId: _outerRequestedModelId,
    fallbackReason: _outerFallbackReason,
    degradedReason: _outerDegradedReason,
    thinkLevel: _outerThinkLevel,
    fastMode: _outerFastMode,
    ...paramsWithoutOuterNativeOwnership
  } = params;
  const supervisedRuntimeModel = {
    id: effectiveRuntimeModelId,
    name: effectiveRuntimeModelId,
    provider: effectiveRuntimeProviderId,
    api: "openai-chatgpt-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: undefined,
    maxTokens: undefined,
  } as unknown as EmbeddedRunAttemptParams["model"];
  const runtimeParams: EmbeddedRunAttemptParams = usesSupervisionConnection
    ? {
        ...paramsWithoutOuterNativeOwnership,
        provider: "codex",
        modelId: effectiveRuntimeModelId,
        model: supervisedRuntimeModel,
        thinkLevel: _outerThinkLevel,
        sessionKey: contextSessionKey,
      }
    : {
        ...params,
        authProfileStore: attemptAuthProfileStore,
        sessionKey: contextSessionKey,
        ...(startupAuthProfileId ? { authProfileId: startupAuthProfileId } : {}),
      };
  const activeSessionId = params.sessionId;
  const activeSessionFile = params.sessionFile;
  const buildActiveRunAttemptParams = (): EmbeddedRunAttemptParams => ({
    ...runtimeParams,
    sessionId: activeSessionId,
    sessionFile: activeSessionFile,
  });
  const startupAuthAccountCacheKey = usesSupervisionConnection
    ? undefined
    : startupPreparedAuth?.kind === "api-key"
      ? resolveCodexAppServerPreparedApiKeyCacheKey(startupPreparedAuth.apiKey)
      : startupPreparedAuth?.kind === "profile"
        ? startupPreparedAuth.snapshot?.secretFreeCacheKey
        : await resolveCodexAppServerAuthAccountCacheKey({
            authProfileId: startupAuthProfileId,
            authProfileStore: attemptAuthProfileStore,
            agentDir,
            config: params.config,
          });
  const startupEnvApiKeyCacheKey = usesSupervisionConnection
    ? undefined
    : startupPreparedAuth || startupAuthProfileId
      ? undefined
      : resolveCodexAppServerFallbackApiKeyCacheKey({ startOptions: appServer.start });
  preDynamicStartupStages.mark("auth-cache");
  const bundleMcpThreadConfig = await loadCodexBundleMcpThreadConfig({
    workspaceDir: effectiveWorkspace,
    cfg: params.config,
    toolsEnabled: usesSupervisionConnection || supportsModelTools(params.model),
    disableTools: params.disableTools,
    toolsAllow: params.toolsAllow,
  });
  preDynamicStartupStages.mark("bundle-mcp");
  const sandboxExecServerEnabled = isCodexSandboxExecServerEnabled(pluginConfig);
  const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(
    runtimeParams,
    sandbox,
    { agentId: sessionAgentId, runtimeSessionKey: sandboxSessionKey, sandboxExecServerEnabled },
  );
  preDynamicStartupStages.mark("native-tool-surface");
  const nativeProviderWebSearchSupport =
    resolveCodexWebSearchPlan({
      config: params.config,
      disableTools: params.disableTools,
      nativeToolSurfaceEnabled,
    }).kind === "native-hosted"
      ? await resolveCodexProviderWebSearchSupport({
          clientFactory: attemptClientFactory,
          appServer,
          authProfileId: startupClientAuthProfileId,
          preparedAuth: startupPreparedAuth,
          agentDir,
          config: params.config,
          modelProviderOverride: usesSupervisionConnection
            ? mutable.startupBinding?.modelProvider
            : resolveCodexAppServerThreadModelSelection({
                provider: params.provider,
                model: params.modelId,
                binding: mutable.startupBinding,
                authProfileId: startupAuthProfileId,
                authProfileStore: attemptAuthProfileStore,
                agentDir,
                config: params.config,
              }).modelProvider,
          signal: runAbortController.signal,
        })
      : "unsupported";
  preDynamicStartupStages.mark("provider-capabilities");
  for (const diagnostic of bundleMcpThreadConfig.diagnostics) {
    embeddedAgentLog.warn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  if (activeContextEngine) {
    assertContextEngineHostSupport({
      contextEngine: activeContextEngine,
      operation: "agent-run",
      host: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
    });
  }
  const hookChannelId = resolveCodexAppServerHookChannelId(params, sandboxSessionKey);
  preDynamicStartupStages.mark("context-engine-support");
  return {
    connection,
    preparedAuthBinding,
    runtimeParams,
    activeSessionId,
    activeSessionFile,
    buildActiveRunAttemptParams,
    attemptAuthProfileStore,
    effectiveContextWindowInfo,
    effectiveContextTokenBudget,
    effectiveRuntimeProviderId,
    effectiveRuntimeModelId,
    startupAuthAccountCacheKey,
    startupEnvApiKeyCacheKey,
    bundleMcpThreadConfig,
    sandboxExecServerEnabled,
    nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport,
    hookChannelId,
  };
}

export type CodexAttemptRuntime = Awaited<ReturnType<typeof prepareCodexAttemptRuntime>>;
