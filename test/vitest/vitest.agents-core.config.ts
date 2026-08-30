// Vitest agents core config wires the agents core test shard.
import { agentVitestProjectOwners } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsCoreVitestConfig(env?: Record<string, string | undefined>) {
  const owner = agentVitestProjectOwners.core;
  return createScopedVitestConfig(owner.include, {
    dir: owner.dir,
    env,
    exclude: owner.exclude,
    fileParallelism: false,
    name: owner.name,
  });
}

export default createAgentsCoreVitestConfig();
