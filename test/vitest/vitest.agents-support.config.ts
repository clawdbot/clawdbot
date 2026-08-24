// Vitest agents support config wires the agents support test shard.
import { agentVitestProjectOwners } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsSupportVitestConfig(env?: Record<string, string | undefined>) {
  const owner = agentVitestProjectOwners.support;
  return createScopedVitestConfig(owner.include, {
    dir: owner.dir,
    env,
    exclude: owner.exclude,
    name: owner.name,
  });
}

export default createAgentsSupportVitestConfig();
