import type { AgentRuntimePolicyConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveAgentRuntimePolicy } from "./agent-runtime-policy.js";
import { listAgentEntries } from "./agent-scope.js";
import {
  normalizeEmbeddedAgentRuntime,
  resolveEmbeddedAgentHarnessFallback,
  type EmbeddedAgentHarnessFallback,
  type EmbeddedAgentRuntime,
} from "./pi-embedded-runner/runtime.js";

type AgentRuntimeMetadata = {
  id: string;
  fallback?: "pi" | "none";
  source: "env" | "agent" | "defaults" | "implicit";
};

function normalizeRuntimeValue(value: unknown): EmbeddedAgentRuntime | undefined {
  const normalized = typeof value === "string" ? normalizeLowercaseStringOrEmpty(value) : "";
  return normalized ? normalizeEmbeddedAgentRuntime(normalized) : undefined;
}

function normalizeAgentHarnessFallback(
  value: EmbeddedAgentHarnessFallback | undefined,
  runtime: EmbeddedAgentRuntime,
): EmbeddedAgentHarnessFallback {
  if (value) {
    return value === "none" ? "none" : "pi";
  }
  return runtime === "auto" ? "pi" : "none";
}

function isPluginAgentRuntime(runtime: string): boolean {
  return runtime !== "auto" && runtime !== "pi";
}

function resolveEffectiveFallback(params: {
  envFallback?: EmbeddedAgentHarnessFallback;
  envRuntime?: string;
  runtime: EmbeddedAgentRuntime;
  agentPolicy?: AgentRuntimePolicyConfig;
  defaultsPolicy?: AgentRuntimePolicyConfig;
}): EmbeddedAgentHarnessFallback | undefined {
  if (params.envFallback) {
    return params.envFallback;
  }

  if (params.envRuntime && isPluginAgentRuntime(params.runtime)) {
    return normalizeAgentHarnessFallback(undefined, params.runtime);
  }

  if (params.agentPolicy?.id) {
    return normalizeAgentHarnessFallback(params.agentPolicy.fallback, params.runtime);
  }

  if (
    params.envRuntime ||
    params.defaultsPolicy?.id ||
    params.agentPolicy?.fallback ||
    params.defaultsPolicy?.fallback
  ) {
    return normalizeAgentHarnessFallback(
      params.agentPolicy?.fallback ?? params.defaultsPolicy?.fallback,
      params.runtime,
    );
  }

  return undefined;
}

export function resolveAgentRuntimeMetadata(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeMetadata {
  const envFallback = resolveEmbeddedAgentHarnessFallback(env);
  const envRuntime = normalizeRuntimeValue(env.OPENCLAW_AGENT_RUNTIME);
  const normalizedAgentId = normalizeAgentId(agentId);
  const agentEntry = listAgentEntries(cfg).find(
    (entry) => normalizeAgentId(entry.id) === normalizedAgentId,
  );
  const agentPolicy = resolveAgentRuntimePolicy(agentEntry);
  const defaultsPolicy = resolveAgentRuntimePolicy(cfg.agents?.defaults);

  if (envRuntime) {
    return {
      id: envRuntime,
      fallback: resolveEffectiveFallback({
        envFallback,
        envRuntime,
        runtime: envRuntime,
        agentPolicy,
        defaultsPolicy,
      }),
      source: "env",
    };
  }

  const agentRuntime = normalizeRuntimeValue(agentPolicy?.id);
  if (agentRuntime) {
    return {
      id: agentRuntime,
      fallback: resolveEffectiveFallback({
        envFallback,
        runtime: agentRuntime,
        agentPolicy,
        defaultsPolicy,
      }),
      source: envFallback ? "env" : "agent",
    };
  }

  const defaultsRuntime = normalizeRuntimeValue(defaultsPolicy?.id);
  if (defaultsRuntime) {
    return {
      id: defaultsRuntime,
      fallback: resolveEffectiveFallback({
        envFallback,
        runtime: defaultsRuntime,
        agentPolicy,
        defaultsPolicy,
      }),
      source: envFallback ? "env" : agentPolicy?.fallback ? "agent" : "defaults",
    };
  }

  return {
    id: "pi",
    fallback: resolveEffectiveFallback({
      envFallback,
      runtime: "pi",
      agentPolicy,
      defaultsPolicy,
    }),
    source: envFallback
      ? "env"
      : agentPolicy?.fallback
        ? "agent"
        : defaultsPolicy?.fallback
          ? "defaults"
          : "implicit",
  };
}
