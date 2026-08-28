import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerLiveThreadOwnership } from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import type { CodexNativeSkillIsolation } from "./native-skill-isolation.js";
import type { CodexPluginThreadConfig } from "./plugin-thread-config.js";
import type { CodexDynamicToolSpec, CodexTurnEnvironmentParams, JsonObject } from "./protocol.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
  CodexAppServerContextEngineBinding,
  CodexAppServerThreadBinding,
} from "./session-binding.js";
import type { CodexContextEngineThreadBootstrapProjection } from "./thread-context-engine.js";
import type {
  CodexThreadLifecycleTimingTracker,
  CodexThreadLifecycleTimingOptions,
} from "./thread-lifecycle-timing.js";
import type { resolveCodexAppServerThreadModelSelection } from "./thread-model-selection.js";
import type { CodexNativeWebSearchSupport } from "./web-search.js";

type CodexAppServerThreadLifecycle = {
  action: "started" | "resumed" | "forked";
  rotatedContextEngineBinding?: boolean;
  activeTurnIds?: string[];
};

export type CodexAppServerThreadLifecycleBinding = CodexAppServerThreadBinding & {
  lifecycle: CodexAppServerThreadLifecycle;
  liveThreadConfigFingerprint?: string;
  /** Process-local claim proof; never write this callback into durable binding state. */
  liveThreadOwnership?: CodexAppServerLiveThreadOwnership;
  clearInheritedServiceTier?: true;
};

type CodexThreadFinalConfigPatchDecision =
  | { action: "resume"; binding: CodexAppServerThreadBinding }
  | { action: "start" };

type CodexThreadFinalConfigPatchResult = {
  configPatch?: JsonObject;
  nativeHookRelayGeneration?: string;
};

export type CodexPluginThreadConfigProvider = {
  enabled: boolean;
  /** Rebuild before reuse so live policy can narrow or revoke stored authority. */
  requiresCurrentPolicyCheck?: boolean;
  inputFingerprint?: string;
  enabledPluginConfigKeys?: readonly string[];
  recoverablePluginConfigKeys?: readonly string[];
  accountAppRecoveryEnabled?: boolean;
  build: (options?: { threadId?: string }) => Promise<CodexPluginThreadConfig>;
};

export type CodexStartOrResumeThreadParams = {
  client: CodexAppServerClient;
  abandonClient?: () => Promise<void>;
  reserveResumeThread?: (threadId: string) => { release: () => void };
  bindingStore: CodexAppServerBindingStore;
  params: EmbeddedRunAttemptParams;
  /** Private execution identity resolved by this harness's catalog generation. */
  runtimeModelId?: string;
  agentId?: string;
  agentDir?: string;
  cwd: string;
  dynamicTools: CodexDynamicToolSpec[];
  persistentWebSearchAllowed?: boolean;
  webSearchAllowed?: boolean;
  appServer: CodexAppServerRuntimeOptions;
  developerInstructions?: string;
  agentWorkspaceDeveloperInstructions?: string;
  config?: JsonObject;
  shellEnvironment?: Readonly<Record<string, string>>;
  disableLoginShell?: boolean;
  finalConfigPatch?: JsonObject;
  buildFinalConfigPatch?: (
    decision: CodexThreadFinalConfigPatchDecision,
  ) => CodexThreadFinalConfigPatchResult;
  nativeHookRelayGeneration?: string;
  /** Session-layer PreToolUse hooks must survive authoritative managed hook requirements. */
  nativeHookRelayRequired?: boolean;
  nativeCodeModeEnabled?: boolean;
  nativeProviderWebSearchSupport?: CodexNativeWebSearchSupport;
  nativeCodeModeOnlyEnabled?: boolean;
  userMcpServersEnabled?: boolean;
  mcpServersFingerprint?: string;
  mcpServersFingerprintEvaluated?: boolean;
  /** Versioned owner of configured MCP for scheduled dynamic-tool execution. */
  configuredMcpOwnershipVersion?: 1;
  environmentSelection?: CodexTurnEnvironmentParams[];
  appServerRuntimeFingerprint?: string;
  pluginThreadConfig?: CodexPluginThreadConfigProvider;
  contextEngineProjection?: CodexContextEngineThreadBootstrapProjection;
  signal?: AbortSignal;
  timing?: CodexThreadLifecycleTimingOptions;
  hostSystemAgentActive?: boolean;
};

export type CodexThreadRequestContext = {
  bindingIdentity: CodexAppServerBindingIdentity;
  startModelSelection: ReturnType<typeof resolveCodexAppServerThreadModelSelection>;
  startModelProvider?: string;
  userMcpServersConfigPatch?: JsonObject;
  dynamicToolsFingerprint: string;
  dynamicToolsContainDeferred: boolean;
  webSearchThreadConfigFingerprint?: string;
  nativeSkillIsolationFingerprint?: string;
  userMcpServersFingerprint?: string;
  ringZeroConfigFingerprint?: string;
  ringZeroClientInstanceId?: string;
  networkProxyConfigFingerprint?: string;
  contextEngineBinding?: CodexAppServerContextEngineBinding;
  environmentSelectionFingerprint?: string;
  hostSystemAgentActive: boolean;
  ringZeroActive: boolean;
  restrictedToolSurface: boolean;
  restrictedToolSurfaceInheritedMcpServerNames: string[];
  nativeSkillIsolation?: CodexNativeSkillIsolation;
  lifecycleTiming: CodexThreadLifecycleTimingTracker;
  normalizeBindingModelProvider: (
    authProfileId: string | undefined,
    modelProvider: string | undefined,
  ) => string | undefined;
  throwIfAborted: () => void;
};
