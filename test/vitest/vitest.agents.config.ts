// Vitest agents config wires the agents test shard.
import { agentVitestProjectOwners } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsVitestConfig(env?: Record<string, string | undefined>) {
  const owner = agentVitestProjectOwners.all;
  return createScopedVitestConfig(owner.include, {
    dir: owner.dir,
    env,
    name: owner.name,
  });
}

export default createAgentsVitestConfig();
