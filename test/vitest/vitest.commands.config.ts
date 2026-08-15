// Vitest commands config wires the commands test shard.
import { commandsLightTestFiles } from "./vitest.commands-light-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createCommandsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/commands/**/*.test.ts"], {
    dir: "src/commands",
    env,
    exclude: commandsLightTestFiles,
    fileParallelism: false,
    name: "commands",
    pool: "forks",
  });
}

export default createCommandsVitestConfig();
