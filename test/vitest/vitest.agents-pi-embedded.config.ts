import { agentsPiEmbeddedTestPatterns } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsPiEmbeddedVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(agentsPiEmbeddedTestPatterns, {
    dir: "src/agents",
    env,
    name: "agents-pi-embedded",
  });
}

export default createAgentsPiEmbeddedVitestConfig();
