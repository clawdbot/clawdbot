// Vitest agents embedded agent config wires the agents embedded agent test shard.
import { agentsEmbeddedTestPatterns } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsEmbeddedVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(agentsEmbeddedTestPatterns, {
    dir: "src/agents",
    env,
    fileParallelism: false,
    name: "agents-embedded-agent",
  });
}

export default createAgentsEmbeddedVitestConfig();
