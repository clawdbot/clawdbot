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
import {
  resolveModelRuntimePolicy,
  type AgentRuntimePolicyScope,
} from "../model-runtime-policy.js";
import { resolveOpenAIImplicitAgentRuntime } from "../openai-routing.js";

/**
 * Effective runtime policy for selecting the agent harness that should execute a turn.
 */
export type AgentHarnessPolicy = {
  runtime: EmbeddedAgentRuntime;
  runtimeSource?: "model" | "provider" | "implicit";
  forcedByEnvironment?: true;
};

/** Resolves model/provider/runtime config into the canonical harness runtime id. */
export function resolveAgentHarnessPolicy(
  params: {
    provider?: string;
    modelId?: string;
    modelApi?: string | null;
    modelBaseUrl?: unknown;
    requestTransportOverrides?: ProviderRouteOverridePresence;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  } & AgentRuntimePolicyScope,
): AgentHarnessPolicy {
  const configured = resolveModelRuntimePolicy(params);
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
  const openAIImplicitRuntime = resolveOpenAIImplicitAgentRuntime({
    ...params,
    api: params.modelApi,
    baseUrl: params.modelBaseUrl,
  });
  if (openAIImplicitRuntime) {
    return { runtime: openAIImplicitRuntime, runtimeSource };
  }
  return {
    runtime,
    runtimeSource,
  };
}
