// Vitest embedded agent run config keeps the run subtree in a bounded serial shard.
import { agentsEmbeddedRunTestPatterns } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsEmbeddedRunVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(agentsEmbeddedRunTestPatterns, {
    dir: "src/agents/embedded-agent-runner/run",
    env,
    fileParallelism: false,
    name: "agents-embedded-agent-run",
  });
}

export default createAgentsEmbeddedRunVitestConfig();
