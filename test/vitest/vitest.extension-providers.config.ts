import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
// Vitest extension providers config wires the extension providers test shard.
import { providerExtensionTestRoots } from "./vitest.extension-provider-paths.mjs";

export function createExtensionProvidersVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("providers", providerExtensionTestRoots, env, {
    isolate: true,
  });
}

export default createExtensionProvidersVitestConfig();
