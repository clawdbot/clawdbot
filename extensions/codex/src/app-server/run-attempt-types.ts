import type {
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  NativeHookRelayEvent,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { CodexAppServerBindingStore } from "./session-binding.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";

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
  turnCompletionIdleTimeoutMs?: number;
  turnAssistantCompletionIdleTimeoutMs?: number;
  postToolRawAssistantCompletionIdleTimeoutMs?: number;
  turnTerminalIdleTimeoutMs?: number;
  clientFactory?: CodexAppServerClientFactory;
};

export type CodexRunAttemptInput = {
  params: EmbeddedRunAttemptParams;
  options: CodexRunAttemptOptions;
};
