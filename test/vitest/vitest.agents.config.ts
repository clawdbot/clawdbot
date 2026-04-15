import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/agents/**/*.test.ts"], {
    dir: "src/agents",
    env,
    fileParallelism: false,
    name: "agents",
  });
}

export default createAgentsVitestConfig();
