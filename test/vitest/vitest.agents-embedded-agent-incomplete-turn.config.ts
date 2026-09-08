// Keep the focused incomplete-turn owner matrix on its existing CI shard boundary.
import { agentVitestProjectOwners } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsEmbeddedIncompleteTurnVitestConfig(
  env?: Record<string, string | undefined>,
) {
  const owner = agentVitestProjectOwners.embeddedIncompleteTurn;
  return createScopedVitestConfig(owner.include, {
    dir: owner.dir,
    env,
    fileParallelism: false,
    name: owner.name,
  });
}

export default createAgentsEmbeddedIncompleteTurnVitestConfig();
