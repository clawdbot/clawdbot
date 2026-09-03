import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentEntry } from "./agent-scope-config.js";

/** Resolve the selected agent's explicit policy before the shared message default. */
export function resolveToolErrorSuppression(
  config: OpenClawConfig | undefined,
  agentId: string | undefined,
): boolean {
  if (!config) {
    return false;
  }
  const agentPolicy = agentId
    ? resolveAgentEntry(config, agentId)?.messages?.suppressToolErrors
    : undefined;
  return agentPolicy ?? config.messages?.suppressToolErrors ?? false;
}
