// Vitest runtime config config wires the runtime config test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createRuntimeConfigVitestConfig(env?: Record<string, string | undefined>) {
  const config = createScopedVitestConfig(["src/config/**/*.test.ts"], {
    dir: "src",
    env,
    includeOpenClawRuntimeSetup: false,
    name: "runtime-config",
    passWithNoTests: true,
  });
  return {
    ...config,
    test: {
      ...config.test,
      sequence: {
        ...config.test?.sequence,
        groupOrder: 3,
      },
    },
  };
}

export default createRuntimeConfigVitestConfig();
