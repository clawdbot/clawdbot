import type {
  AgentHarnessRuntimeArtifactBinding,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  NativeHookRelayEvent,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import type { CodexSandboxPolicy, CodexTurnEnvironmentParams } from "./protocol.js";
import type { CodexSandboxExecEnvironment } from "./sandbox-exec-server.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";
import type { CodexAppServerThreadLifecycleBinding } from "./thread-lifecycle-types.js";
import type { CodexAppServerTurnRouter, CodexThreadRouteReservation } from "./turn-router.js";

export type CodexRunAttemptOptions = {
  bindingStore: CodexAppServerBindingStore;
  runtime?: PluginRuntime;
  pluginConfig?: unknown;
  /** Private app-server request identity; public attempt identity remains params.modelId. */
  runtimeModelId?: string;
  startupTimeoutFloorMs?: number;
  nativeHookRelay?: {
    enabled?: boolean;
    events?: readonly NativeHookRelayEvent[];
    ttlMs?: number;
    gatewayTimeoutMs?: number;
    hookTimeoutSec?: number;
  };
  clientFactory?: CodexAppServerClientFactory;
};

export type CodexRunAttemptInput = {
  params: EmbeddedRunAttemptParams;
  options: CodexRunAttemptOptions;
};

/** Resources and bindings returned after a Codex attempt thread starts. */
export type StartCodexAttemptThreadResult = {
  client: CodexAppServerClient;
  turnRouter: CodexAppServerTurnRouter;
  turnRoute: CodexThreadRouteReservation;
  thread: CodexAppServerThreadLifecycleBinding;
  pluginAppServer: CodexAppServerRuntimeOptions;
  sandboxEnvironment: CodexSandboxExecEnvironment | undefined;
  environmentSelection: CodexTurnEnvironmentParams[] | undefined;
  executionCwd: string;
  sandboxPolicy: CodexSandboxPolicy | undefined;
  runtimeArtifact?: AgentHarnessRuntimeArtifactBinding;
  releaseSharedClientLease: () => void;
  restartContextEngineCodexThread: () => Promise<CodexAppServerThreadLifecycleBinding>;
};
