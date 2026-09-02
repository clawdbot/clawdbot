import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
// Vitest extension misc config wires the extension misc test shard.
import { miscExtensionTestRoots } from "./vitest.extension-misc-paths.mjs";

export function createExtensionMiscVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("misc", miscExtensionTestRoots, env);
}

export default createExtensionMiscVitestConfig();
