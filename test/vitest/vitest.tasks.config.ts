// Vitest tasks config wires the tasks test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createTasksVitestConfig(env?: Record<string, string | undefined>) {
  const config = createScopedVitestConfig(["src/tasks/**/*.test.ts"], {
    dir: "src",
    env,
    name: "tasks",
    passWithNoTests: true,
  });
  // Task tests mutate process.env and shared singleton registries/state dirs.
  // Keep files serialized so temp-dir-backed sqlite stores do not fight each
  // other under the non-isolated runner.
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

export default createTasksVitestConfig();
