import { listAgentEntries } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "./types.js";

/** Attach the non-serialized list projection used by legacy runtime consumers. */
export function attachAgentListProjection(config: OpenClawConfig): OpenClawConfig {
  const agents = config.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    return config;
  }
  Object.defineProperty(agents, "list", {
    configurable: true,
    enumerable: false,
    value: listAgentEntries(config),
    writable: false,
  });
  return config;
}
