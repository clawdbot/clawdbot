import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveAgentRuntimePolicy } from "./agent-runtime-policy.js";
import { listAgentEntries } from "./agent-scope.js";
import {
  normalizeEmbeddedAgentRuntime,
  type EmbeddedAgentRuntime,
} from "./pi-embedded-runner/runtime.js";

type AgentRuntimeMetadata = {
  id: string;
  source: "env" | "agent" | "defaults" | "implicit";
};

function normalizeRuntimeValue(value: unknown): EmbeddedAgentRuntime | undefined {
  const normalized = typeof value === "string" ? normalizeLowercaseStringOrEmpty(value) : "";
  return normalized ? normalizeEmbeddedAgentRuntime(normalized) : undefined;
}

export function resolveAgentRuntimeMetadata(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeMetadata {
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
      source: "env",
    };
  }

  const agentRuntime = normalizeRuntimeValue(agentPolicy?.id);
  if (agentRuntime) {
    return {
      id: agentRuntime,
      source: "agent",
    };
  }

  const defaultsRuntime = normalizeRuntimeValue(defaultsPolicy?.id);
  if (defaultsRuntime) {
    return {
      id: defaultsRuntime,
      source: "defaults",
    };
  }

  return {
    id: "pi",
    source: "implicit",
  };
}
