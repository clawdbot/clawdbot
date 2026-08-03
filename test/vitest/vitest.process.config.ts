// Vitest process config wires the process test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createProcessVitestConfig(env?: Record<string, string | undefined>) {
  const config = createScopedVitestConfig(["src/process/**/*.test.ts"], {
    dir: "src",
    env,
    includeOpenClawRuntimeSetup: false,
    name: "process",
    passWithNoTests: true,
  });
  return {
    ...config,
    test: {
      ...config.test,
      sequence: {
        ...config.test?.sequence,
        groupOrder: 2,
      },
    },
  };
}

export default createProcessVitestConfig();
