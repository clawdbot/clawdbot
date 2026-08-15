// Vitest cron config wires the cron test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createCronVitestConfig(env?: Record<string, string | undefined>) {
  const config = createScopedVitestConfig(["src/cron/**/*.test.ts"], {
    dir: "src",
    env,
    name: "cron",
    passWithNoTests: true,
  });
  config.test = {
    ...config.test,
    maxWorkers: 1,
    fileParallelism: false,
    sequence: {
      ...config.test?.sequence,
      groupOrder: 1,
    },
  };
  return config;
}

export default createCronVitestConfig();
