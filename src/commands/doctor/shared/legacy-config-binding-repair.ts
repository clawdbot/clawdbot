// Repairs canonical binding references after agent config migration.
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";

export function pruneBindingsForMissingAgents(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const agents = cfg.agents?.list;
  const bindings = cfg.bindings;
  if (!Array.isArray(agents) || agents.length === 0 || !Array.isArray(bindings)) {
    return cfg;
  }

  const validAgents = agents.filter((agent): agent is { id: string } => {
    return agent !== null && typeof agent === "object" && typeof agent.id === "string";
  });
  if (validAgents.length !== agents.length) {
    return cfg;
  }

  const agentIds = new Set(validAgents.map((agent) => normalizeAgentId(agent.id)));
  const nextBindings = bindings.filter((binding) => {
    const agentId = binding && typeof binding === "object" ? binding.agentId : undefined;
    return typeof agentId !== "string" || agentIds.has(normalizeAgentId(agentId));
  });
  const removed = bindings.length - nextBindings.length;
  if (removed === 0) {
    return cfg;
  }

  changes.push(
    `Removed ${removed} binding${removed === 1 ? "" : "s"} that referenced missing agents.list ids.`,
  );
  return {
    ...cfg,
    ...(nextBindings.length > 0 ? { bindings: nextBindings } : { bindings: undefined }),
  };
}
