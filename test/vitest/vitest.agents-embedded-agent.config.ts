// Vitest agents embedded agent config wires the agents embedded agent test shard.
import {
  agentsEmbeddedIncompleteTurnTestFiles,
  agentsEmbeddedOverflowCompactionTestFiles,
  agentsEmbeddedTestPatterns,
} from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsEmbeddedVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(agentsEmbeddedTestPatterns, {
    dir: "src/agents",
    env,
    exclude: [
      ...agentsEmbeddedIncompleteTurnTestFiles,
      ...agentsEmbeddedOverflowCompactionTestFiles,
    ],
    fileParallelism: false,
    // Cold shared harness imports exceed the generic limit on 2-vCPU hosted release runners.
    hookTimeout: 600_000,
    name: "agents-embedded-agent",
  });
}

export default createAgentsEmbeddedVitestConfig();
