import { hasAgentRosterProperty } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Adds the canonical test roster only when a fixture intentionally omits one. */
export function withCanonicalTestAgentRoster(config: OpenClawConfig): OpenClawConfig {
  return hasAgentRosterProperty(config)
    ? config
    : {
        ...config,
        agents: { ...config.agents, entries: { main: { default: true } } },
      };
}
