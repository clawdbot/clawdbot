import { commandsLightTestFiles } from "./vitest.commands-light-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { getUnitFastTestFiles } from "./vitest.unit-fast-paths.mjs";

export function createCommandsLightVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(commandsLightTestFiles, {
    dir: "src/commands",
    env,
    exclude: getUnitFastTestFiles(),
    includeOpenClawRuntimeSetup: false,
    name: "commands-light",
    passWithNoTests: true,
  });
}

export default createCommandsLightVitestConfig();
