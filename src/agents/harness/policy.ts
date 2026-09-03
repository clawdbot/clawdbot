/**
 * Resolves configured native harness policy for agent ids.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRouteOverridePresence } from "../../plugin-sdk/provider-model-types.js";
import {
  AUTO_AGENT_RUNTIME_ID,
  type EmbeddedAgentRuntime,
  normalizeOptionalAgentRuntimeId,
} from "../agent-runtime-id.js";
import { resolveCliRuntimeExecutionProvider } from "../model-runtime-aliases.js";
import { resolveModelRuntimePolicy } from "../model-runtime-policy.js";
import { resolveOpenAIImplicitAgentRuntime } from "../openai-routing.js";

/** Who chose the runtime: operator config, an implicit default, or the credentials in use. */
export type AgentHarnessRuntimeSource = "model" | "provider" | "implicit" | "auth";

export type AgentHarnessPolicy = {
  runtime: EmbeddedAgentRuntime;
  runtimeSource?: AgentHarnessRuntimeSource;
  forcedByEnvironment?: true;
};

/** Resolves model/provider/runtime config into the canonical harness runtime id. */
export function resolveAgentHarnessPolicy(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  modelBaseUrl?: unknown;
  requestTransportOverrides?: ProviderRouteOverridePresence;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  env?: NodeJS.ProcessEnv;
}): AgentHarnessPolicy {
  const configured = resolveModelRuntimePolicy({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const configuredRuntime = normalizeOptionalAgentRuntimeId(configured.policy?.id);
  const runtime =
    configuredRuntime && configuredRuntime !== "default"
      ? configuredRuntime
      : AUTO_AGENT_RUNTIME_ID;
  const runtimeSource =
    runtime === AUTO_AGENT_RUNTIME_ID ? "implicit" : (configured.source ?? "implicit");
  if (runtime !== "auto") {
    return {
      runtime,
      runtimeSource,
      ...(configured.forcedByEnvironment ? { forcedByEnvironment: true } : {}),
    };
  }
  // Credentials chose this runtime, not the provider's default route. Check native
  // login first so model surfaces can distinguish a logged-in CLI from an unavailable one.
  const cliRuntime = resolveCliRuntimeExecutionProvider({
    provider: params.provider ?? "",
    cfg: params.config,
    agentId: params.agentId,
    modelId: params.modelId,
  });
  if (cliRuntime) {
    return { runtime: cliRuntime, runtimeSource: "auth" };
  }
  const openAIImplicitRuntime = resolveOpenAIImplicitAgentRuntime({
    provider: params.provider,
    modelId: params.modelId,
    api: params.modelApi,
    baseUrl: params.modelBaseUrl,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    env: params.env,
    requestTransportOverrides: params.requestTransportOverrides,
  });
  if (openAIImplicitRuntime) {
    return { runtime: openAIImplicitRuntime, runtimeSource };
  }
  return {
    runtime,
    runtimeSource,
  };
}
