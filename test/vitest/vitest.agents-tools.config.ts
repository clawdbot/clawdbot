// Vitest agents tools config wires the agents tools test shard.
import { agentsToolsTestPatterns } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsToolsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(agentsToolsTestPatterns, {
    dir: "src/agents",
    env,
    fileParallelism: false,
    name: "agents-tools",
  });
}

export default createAgentsToolsVitestConfig();
