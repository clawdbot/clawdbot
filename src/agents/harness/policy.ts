/**
 * Resolves configured native harness policy for agent ids.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AUTO_AGENT_RUNTIME_ID, type EmbeddedAgentRuntime } from "../agent-runtime-id.js";
import { normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { resolveModelRuntimePolicy } from "../model-runtime-policy.js";
import { openAIProviderUsesCodexRuntimeByDefault } from "../openai-routing.js";

/**
 * Effective runtime policy for selecting the agent harness that should execute a turn.
 */
export type AgentHarnessPolicy = {
  runtime: EmbeddedAgentRuntime;
  runtimeSource?: "model" | "provider" | "implicit";
};

/** Resolves model/provider/runtime config into the canonical harness runtime id. */
export function resolveAgentHarnessPolicy(params: {
  provider?: string;
  modelId?: string;
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
  const runtimeSource = configured.source ?? "implicit";
  const runtime =
    configuredRuntime && configuredRuntime !== "default"
      ? configuredRuntime
      : AUTO_AGENT_RUNTIME_ID;
  if (
    openAIProviderUsesCodexRuntimeByDefault({ provider: params.provider, config: params.config })
  ) {
    if (runtime === "auto") {
      return { runtime: "codex", runtimeSource };
    }
    return { runtime, runtimeSource };
  }
  return {
    runtime,
    runtimeSource,
  };
}
