// Vitest plugin sdk light config wires the plugin sdk light test shard.
import { pluginSdkLightTestFiles } from "./vitest.plugin-sdk-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createPluginSdkLightVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(pluginSdkLightTestFiles, {
    dir: "src",
    env,
    includeOpenClawRuntimeSetup: false,
    name: "plugin-sdk-light",
    passWithNoTests: true,
  });
}

export default createPluginSdkLightVitestConfig();
