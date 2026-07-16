// Vitest agents core config wires the agents core test shard.
import { agentsCoreIsolatedTestFiles, agentsCoreTestPatterns } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsCoreVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(agentsCoreTestPatterns, {
    dir: "src/agents",
    env,
    exclude: agentsCoreIsolatedTestFiles,
    fileParallelism: false,
    name: "agents-core",
  });
}

export default createAgentsCoreVitestConfig();
