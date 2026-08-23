// Vitest agents tools config wires the agents tools test shard.
import { agentVitestProjectOwners } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsToolsVitestConfig(env?: Record<string, string | undefined>) {
  const owner = agentVitestProjectOwners.tools;
  return createScopedVitestConfig(owner.include, {
    dir: owner.dir,
    env,
    fileParallelism: false,
    name: owner.name,
  });
}

export default createAgentsToolsVitestConfig();
