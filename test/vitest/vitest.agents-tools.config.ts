import { agentsToolsTestPatterns } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsToolsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(agentsToolsTestPatterns, {
    dir: "src/agents",
    env,
    name: "agents-tools",
  });
}

export default createAgentsToolsVitestConfig();
