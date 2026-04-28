import { agentsSupportExcludePatterns, agentsSupportTestPatterns } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsSupportVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(agentsSupportTestPatterns, {
    dir: "src/agents",
    env,
    exclude: agentsSupportExcludePatterns,
    name: "agents-support",
  });
}

export default createAgentsSupportVitestConfig();
